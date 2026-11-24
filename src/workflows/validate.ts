/**
 * [#318] 工作流文档校验（多 Agent 工作流设计稿 §4.2、§5.7）。纯函数，属于 `./workflow` 入口。
 * 不补缺省值、不改写 glob、未知字段报错；返回的文档只含输入里出现的已知字段（`null` 原样保留）。
 */
import { isTierName } from "../agents/tier-ladder.js";
import { globsOverlap, validateOwnsGlob } from "./glob.js";
import {
  WORKFLOW_AGENT_ID_PATTERN,
  WORKFLOW_FORMAT_VERSION,
  WORKFLOW_ID_PATTERN,
  WORKFLOW_LIMITS,
  WORKFLOW_PARAM_PATTERN,
  WORKFLOW_PARAM_TYPES,
  WORKFLOW_PERMISSION_MODES,
  type WorkflowDocument,
  type WorkflowIssue,
  type WorkflowValidation,
} from "./types.js";

type Json = Record<string, unknown>;

const TOP_KEYS = [
  "version",
  "title",
  "description",
  "params",
  "roles",
  "links",
  "steps",
  "contract",
  "source",
];
const PARAM_KEYS = ["name", "type", "label", "default"];
const ROLE_KEYS = ["id", "agentId", "title", "permissionMode", "model", "worktree", "tier"];
const LINK_KEYS = ["from", "to", "role"];
const PROMPT_KEYS = ["id", "kind", "role", "prompt", "after"];
const COLLECT_KEYS = [...PROMPT_KEYS, "from", "verify", "maxRetries"];
const GATE_KEYS = ["id", "kind", "label", "after"];
const VERIFY_KEYS = ["commands", "checklist"];
const CONTRACT_KEYS = ["text", "owns"];
const SOURCE_KEYS = ["boardId", "nodeIds", "proposedBy", "sessionId"];

const cp = (s: string): number => [...s].length;
const isObject = (v: unknown): v is Json =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const present = (v: unknown): boolean => v !== undefined && v !== null;

class Checker {
  readonly errors: WorkflowIssue[] = [];
  readonly warnings: WorkflowIssue[] = [];

  error(path: string, message: string): void {
    this.errors.push({ path, message, severity: "error" });
  }
  warn(path: string, message: string): void {
    this.warnings.push({ path, message, severity: "warning" });
  }

  object(v: unknown, path: string, known: readonly string[]): Json | undefined {
    if (!isObject(v)) {
      this.error(path, "must be an object");
      return undefined;
    }
    for (const key of Object.keys(v)) {
      if (!known.includes(key)) this.error(path, `unknown field "${key}"`);
    }
    return v;
  }

  /** 非空字符串，按码点计长度；`optional` 时 undefined / null 通过。返回值有效才给。 */
  str(v: unknown, path: string, max: number, optional = false): boolean {
    if (v === undefined || v === null) {
      if (!optional) this.error(path, "is required");
      return optional;
    }
    if (typeof v !== "string" || v.length === 0) {
      this.error(path, "must be a non-empty string");
      return false;
    }
    if (cp(v) > max) {
      this.error(path, `must be at most ${max} characters`);
      return false;
    }
    return true;
  }

  ident(v: unknown, path: string): v is string {
    if (typeof v === "string" && WORKFLOW_ID_PATTERN.test(v)) return true;
    this.error(path, "must be an identifier: a letter first, at most 32 letters, digits, _ or -");
    return false;
  }

  /** 数组；`required` 为 false 时 undefined / null 通过并返回 undefined。 */
  list(v: unknown, path: string, max: number, min = 0): unknown[] | undefined {
    if (v === undefined || v === null) {
      if (min > 0) this.error(path, "is required");
      return undefined;
    }
    if (!Array.isArray(v)) {
      this.error(path, "must be an array");
      return undefined;
    }
    if (v.length < min) this.error(path, `needs at least ${min} item${min === 1 ? "" : "s"}`);
    if (v.length > max) this.error(path, `has more than ${max} items`);
    return v;
  }

  strings(v: unknown, path: string, maxCount: number, maxLength: number): string[] | undefined {
    const items = this.list(v, path, maxCount);
    if (items === undefined) return undefined;
    const out: string[] = [];
    items.forEach((item, i) => {
      if (this.str(item, `${path}[${i}]`, maxLength)) out.push(item as string);
    });
    return out;
  }

  unique(values: readonly string[], path: string, label: string): Set<string> {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) this.error(path, `${label} "${value}" is duplicated`);
      seen.add(value);
    }
    return seen;
  }
}

function checkParam(c: Checker, raw: unknown, path: string): void {
  const p = c.object(raw, path, PARAM_KEYS);
  if (p === undefined) return;
  if (typeof p.name !== "string" || !WORKFLOW_PARAM_PATTERN.test(p.name)) {
    c.error(`${path}.name`, "must be letters, digits and _, not starting with a digit");
  }
  if (present(p.type) && !(WORKFLOW_PARAM_TYPES as readonly unknown[]).includes(p.type)) {
    c.error(`${path}.type`, `must be one of ${WORKFLOW_PARAM_TYPES.join(", ")}`);
  }
  c.str(p.label, `${path}.label`, WORKFLOW_LIMITS.label, true);
  if (present(p.default)) {
    if (typeof p.default !== "string" || cp(p.default) > WORKFLOW_LIMITS.paramValue) {
      c.error(
        `${path}.default`,
        `must be a string of at most ${WORKFLOW_LIMITS.paramValue} characters`,
      );
    }
  }
}

function checkRole(c: Checker, raw: unknown, path: string): void {
  const r = c.object(raw, path, ROLE_KEYS);
  if (r === undefined) return;
  c.ident(r.id, `${path}.id`);
  if (typeof r.agentId !== "string" || !WORKFLOW_AGENT_ID_PATTERN.test(r.agentId)) {
    c.error(`${path}.agentId`, "must be an agent id, custom:<name> (1-64 characters) or acp:<id>");
  }
  if (
    present(r.permissionMode) &&
    !(WORKFLOW_PERMISSION_MODES as readonly unknown[]).includes(r.permissionMode)
  ) {
    c.error(`${path}.permissionMode`, `must be one of ${WORKFLOW_PERMISSION_MODES.join(", ")}`);
  }
  c.str(r.title, `${path}.title`, WORKFLOW_LIMITS.title, true);
  c.str(r.model, `${path}.model`, WORKFLOW_LIMITS.model, true);
  c.str(r.worktree, `${path}.worktree`, WORKFLOW_LIMITS.worktree, true);
  if (present(r.tier) && !isTierName(r.tier)) {
    c.error(`${path}.tier`, "must be one of light, standard, strong, max");
  }
}

function checkVerify(c: Checker, raw: unknown, path: string): void {
  const v = c.object(raw, path, VERIFY_KEYS);
  if (v === undefined) return;
  const commands = c.strings(
    v.commands,
    `${path}.commands`,
    WORKFLOW_LIMITS.verifyCommands,
    WORKFLOW_LIMITS.verifyItem,
  );
  const checklist = c.strings(
    v.checklist,
    `${path}.checklist`,
    WORKFLOW_LIMITS.checklist,
    WORKFLOW_LIMITS.verifyItem,
  );
  if ((commands?.length ?? 0) + (checklist?.length ?? 0) === 0) {
    c.error(path, "needs at least one command or checklist item");
  }
}

function checkStep(c: Checker, raw: unknown, path: string): void {
  if (!isObject(raw)) {
    c.error(path, "must be an object");
    return;
  }
  const kind = raw.kind;
  if (kind !== "prompt" && kind !== "collect" && kind !== "gate") {
    c.error(`${path}.kind`, "must be one of prompt, collect, gate");
    c.object(raw, path, COLLECT_KEYS);
    return;
  }
  const s = c.object(
    raw,
    path,
    kind === "prompt" ? PROMPT_KEYS : kind === "collect" ? COLLECT_KEYS : GATE_KEYS,
  )!;
  c.ident(s.id, `${path}.id`);
  if (kind === "gate") {
    c.str(s.label, `${path}.label`, WORKFLOW_LIMITS.label);
    return;
  }
  c.ident(s.role, `${path}.role`);
  c.str(s.prompt, `${path}.prompt`, WORKFLOW_LIMITS.prompt);
  if (kind !== "collect") return;
  const from = c.list(s.from, `${path}.from`, WORKFLOW_LIMITS.steps, 1);
  from?.forEach((id, i) => c.ident(id, `${path}.from[${i}]`));
  if (present(s.verify)) checkVerify(c, s.verify, `${path}.verify`);
  if (present(s.maxRetries)) {
    const n = s.maxRetries;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > WORKFLOW_LIMITS.maxRetries) {
      c.error(`${path}.maxRetries`, `must be an integer from 0 to ${WORKFLOW_LIMITS.maxRetries}`);
    } else if (!present(s.verify)) {
      c.error(`${path}.maxRetries`, "is only allowed together with verify");
    }
  }
}

function findCycle(edges: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    const mark = state.get(id);
    if (mark === 2) return undefined;
    if (mark === 1) return [...path.slice(path.indexOf(id)), id];
    state.set(id, 1);
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      const found = visit(next);
      if (found !== undefined) return found;
    }
    path.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const id of edges.keys()) {
    const found = visit(id);
    if (found !== undefined) return found;
  }
  return undefined;
}

function checkContract(
  c: Checker,
  raw: unknown,
  roleIds: ReadonlySet<string>,
  roleOrder: readonly string[],
): void {
  const k = c.object(raw, "contract", CONTRACT_KEYS);
  if (k === undefined) return;
  c.str(k.text, "contract.text", WORKFLOW_LIMITS.contractText, true);
  if (!present(k.text) && !present(k.owns)) c.error("contract", "needs text or owns");
  if (!present(k.owns)) return;
  if (!isObject(k.owns)) {
    c.error("contract.owns", "must be an object");
    return;
  }
  const valid = new Map<string, string[]>();
  for (const [role, value] of Object.entries(k.owns)) {
    const path = `contract.owns.${role}`;
    if (!roleIds.has(role)) c.error("contract.owns", `"${role}" is not a role`);
    const globs = c.list(value, path, WORKFLOW_LIMITS.ownsPerRole, 0);
    if (globs === undefined) {
      if (value === null) c.error(path, "must be an array");
      continue;
    }
    const ok: string[] = [];
    globs.forEach((g, i) => {
      const gp = `${path}[${i}]`;
      if (!c.str(g, gp, WORKFLOW_LIMITS.glob)) return;
      const reason = validateOwnsGlob(g as string);
      if (reason !== undefined) c.error(gp, `invalid glob "${g as string}" (${reason})`);
      else ok.push(g as string);
    });
    valid.set(role, ok);
  }
  const ordered = [...valid.keys()].sort((a, b) => roleOrder.indexOf(a) - roleOrder.indexOf(b));
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const ra = ordered[i]!;
      const rb = ordered[j]!;
      const hit = findOverlap(valid.get(ra)!, valid.get(rb)!);
      if (hit !== undefined) {
        c.error("contract.owns", `${ra} "${hit[0]}" overlaps ${rb} "${hit[1]}"`);
      }
    }
  }
}

function findOverlap(as: readonly string[], bs: readonly string[]): [string, string] | undefined {
  for (const a of as) for (const b of bs) if (globsOverlap(a, b)) return [a, b];
  return undefined;
}

function checkSource(c: Checker, raw: unknown): void {
  const s = c.object(raw, "source", SOURCE_KEYS);
  if (s === undefined) return;
  c.str(s.boardId, "source.boardId", 200, true);
  c.str(s.proposedBy, "source.proposedBy", 64, true);
  c.str(s.sessionId, "source.sessionId", 200, true);
  if (present(s.nodeIds)) {
    const ids = c.list(s.nodeIds, "source.nodeIds", 64);
    ids?.forEach((n, i) => {
      if (typeof n !== "string") c.error(`source.nodeIds[${i}]`, "must be a string");
    });
  }
}

/** 去掉 undefined 的浅拷贝，保持键序；返回的对象只含输入里有的字段。 */
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean);
  if (isObject(v)) {
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = clean(x);
    return out;
  }
  return v;
}

/** 不补缺省值、不改写 glob。 */
export function validateWorkflow(raw: unknown): WorkflowValidation {
  const c = new Checker();
  const done = (): WorkflowValidation =>
    c.errors.length > 0
      ? { ok: false, errors: c.errors, warnings: c.warnings }
      : { ok: true, workflow: clean(raw) as WorkflowDocument, warnings: c.warnings };

  const doc = c.object(raw, "$", TOP_KEYS);
  if (doc === undefined) return done();
  try {
    if (new TextEncoder().encode(JSON.stringify(doc)).length > WORKFLOW_LIMITS.draftBytes) {
      c.error("$", `is larger than ${WORKFLOW_LIMITS.draftBytes} bytes`);
      return done();
    }
  } catch {
    c.error("$", "is not valid JSON data");
    return done();
  }

  if (doc.version !== WORKFLOW_FORMAT_VERSION) c.error("version", "version must be 2");
  c.str(doc.title, "title", WORKFLOW_LIMITS.title);
  c.str(doc.description, "description", WORKFLOW_LIMITS.description, true);

  const params = c.list(doc.params, "params", WORKFLOW_LIMITS.params);
  params?.forEach((p, i) => checkParam(c, p, `params[${i}]`));
  const roles = c.list(doc.roles, "roles", WORKFLOW_LIMITS.roles, 1);
  roles?.forEach((r, i) => checkRole(c, r, `roles[${i}]`));
  const links = c.list(doc.links, "links", WORKFLOW_LIMITS.links);
  const steps = c.list(doc.steps, "steps", WORKFLOW_LIMITS.steps, 1);
  steps?.forEach((s, i) => checkStep(c, s, `steps[${i}]`));

  const field = (items: unknown[] | undefined, key: string): string[] =>
    (items ?? []).flatMap((item) =>
      isObject(item) && typeof item[key] === "string" ? [item[key] as string] : [],
    );
  c.unique(field(params, "name"), "params", "name");
  const roleList = field(roles, "id");
  const roleIds = c.unique(roleList, "roles", "id");
  const stepIds = c.unique(field(steps, "id"), "steps", "id");

  links?.forEach((raw, i) => {
    const path = `links[${i}]`;
    const l = c.object(raw, path, LINK_KEYS);
    if (l === undefined) return;
    const okFrom = c.ident(l.from, `${path}.from`);
    const okTo = c.ident(l.to, `${path}.to`);
    if (present(l.role) && l.role !== "peer" && l.role !== "supervises") {
      c.error(`${path}.role`, "must be peer or supervises");
    }
    if (okFrom && !roleIds.has(l.from as string))
      c.error(`${path}.from`, `"${l.from as string}" is not a role`);
    if (okTo && !roleIds.has(l.to as string))
      c.error(`${path}.to`, `"${l.to as string}" is not a role`);
    if (okFrom && okTo && l.from === l.to) c.error(path, "connects a role to itself");
  });

  const edges = new Map<string, readonly string[]>();
  steps?.forEach((raw, i) => {
    if (!isObject(raw)) return;
    const path = `steps[${i}]`;
    const id = typeof raw.id === "string" ? raw.id : "";
    if (
      (raw.kind === "prompt" || raw.kind === "collect") &&
      typeof raw.role === "string" &&
      WORKFLOW_ID_PATTERN.test(raw.role) &&
      !roleIds.has(raw.role)
    ) {
      c.error(`${path}.role`, `"${raw.role}" is not a role`);
    }
    const after = c.list(raw.after, `${path}.after`, WORKFLOW_LIMITS.steps);
    const afterIds: string[] = [];
    after?.forEach((a, j) => {
      const ap = `${path}.after[${j}]`;
      if (!c.ident(a, ap)) return;
      if (a === id) c.error(ap, "a step cannot come after itself");
      else if (!stepIds.has(a)) c.error(ap, `"${a}" is not a step`);
      afterIds.push(a);
    });
    if (id !== "") edges.set(id, afterIds);
    if (raw.kind === "collect" && Array.isArray(raw.from)) {
      raw.from.forEach((f, j) => {
        if (typeof f === "string" && !afterIds.includes(f)) {
          c.error(`${path}.from[${j}]`, `"${f}" must also be listed in after`);
        }
      });
    }
  });
  const cycle = findCycle(edges);
  if (cycle !== undefined) c.error("steps", `after forms a cycle: ${cycle.join(" -> ")}`);

  if (present(doc.contract)) checkContract(c, doc.contract, roleIds, roleList);
  if (present(doc.source)) checkSource(c, doc.source);

  const trees = new Map<string, number>();
  for (const r of roles ?? []) {
    if (isObject(r) && typeof r.worktree === "string") {
      trees.set(r.worktree, (trees.get(r.worktree) ?? 0) + 1);
    }
  }
  for (const [name, count] of trees) {
    if (count > 1) {
      c.warn(
        "roles",
        `roles share worktree "${name}"; standalone runs give each role its own worktree`,
      );
    }
  }
  return done();
}
