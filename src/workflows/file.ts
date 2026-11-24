/**
 * [#318] 工作流文件的解析与格式化（多 Agent 工作流设计稿 §4.1、§5.7）：
 * `---` 围栏内是 YAML frontmatter，围栏后的正文是 `description`。纯函数，不读写文件；属于 `./workflow` 入口。
 */
import { validateWorkflow } from "./validate.js";
import type { WorkflowDocument, WorkflowFileParse } from "./types.js";
import { parseYaml, stringifyYaml, type YamlValue } from "./yaml.js";

const FENCE = /^---[ \t]*$/;

function fail(path: string, message: string): WorkflowFileParse {
  return { issues: [{ path, message, severity: "error" }] };
}

export function parseWorkflowFile(text: string): WorkflowFileParse {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  if (!FENCE.test(lines[0] ?? ""))
    return fail("frontmatter", "file must start with a --- frontmatter fence");
  const close = lines.findIndex((line, i) => i > 0 && FENCE.test(line));
  if (close < 0) return fail("frontmatter", "frontmatter is not closed by a --- line");

  const parsed = parseYaml(lines.slice(1, close).join("\n"));
  if (parsed.errors.length > 0) {
    return {
      issues: parsed.errors.map((e) => ({
        path: "frontmatter",
        message: `line ${e.line + 1}: ${e.message}`,
        severity: "error" as const,
      })),
    };
  }
  const value = parsed.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("frontmatter", "frontmatter must be a mapping");
  }
  const raw: Record<string, unknown> = { ...value };
  if ("description" in raw) return fail("description", "description belongs in the body");

  const body = lines.slice(close + 1);
  while (body.length > 0 && body[0]!.trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1]!.trim() === "") body.pop();
  if (body.length > 0) raw.description = body.join("\n");

  const result = validateWorkflow(raw);
  if (!result.ok) return { issues: [...result.errors, ...result.warnings] };
  return { workflow: result.workflow, issues: result.warnings };
}

const ORDER = {
  doc: ["version", "title", "params", "roles", "links", "contract", "steps", "source"],
  param: ["name", "type", "label", "default"],
  role: ["id", "agentId", "title", "permissionMode", "model", "worktree", "tier"],
  link: ["from", "to", "role"],
  prompt: ["id", "kind", "role", "prompt", "after"],
  collect: ["id", "kind", "role", "from", "prompt", "after", "verify", "maxRetries"],
  gate: ["id", "kind", "label", "after"],
  verify: ["commands", "checklist"],
  contract: ["text", "owns"],
  source: ["boardId", "nodeIds", "proposedBy", "sessionId"],
} as const;

/** 按固定键序取值，省略 undefined 与 null；其余字段不写。 */
function pick(
  obj: object,
  keys: readonly string[],
  children: Record<string, (v: never) => YamlValue> = {},
): YamlValue {
  const src = obj as Record<string, unknown>;
  const out: { [key: string]: YamlValue } = {};
  for (const key of keys) {
    const v = src[key];
    if (v === undefined || v === null) continue;
    const child = children[key];
    out[key] = child !== undefined ? child(v as never) : (v as YamlValue);
  }
  return out;
}

const each =
  <T>(f: (x: T) => YamlValue) =>
  (xs: readonly T[]): YamlValue =>
    xs.map(f);

/** 只写文档里有的字段（省略 null；空的 params / links 也省略）；description 写成正文。 */
export function formatWorkflowFile(w: WorkflowDocument): string {
  const doc = pick(w, ORDER.doc, {
    params: each((p: object) => pick(p, ORDER.param)),
    roles: each((r: object) => pick(r, ORDER.role)),
    links: each((l: object) => pick(l, ORDER.link)),
    steps: each((s: { kind: "prompt" | "collect" | "gate" }) =>
      pick(s, ORDER[s.kind], { verify: (v: object) => pick(v, ORDER.verify) }),
    ),
    contract: (k: object) => pick(k, ORDER.contract),
    source: (s: object) => pick(s, ORDER.source),
  }) as { [key: string]: YamlValue };
  for (const key of ["params", "links"]) {
    const v = doc[key];
    if (Array.isArray(v) && v.length === 0) delete doc[key];
  }
  const head = `---\n${stringifyYaml(doc)}---\n`;
  const body = w.description;
  return body === undefined || body === null || body === "" ? head : `${head}\n${body}\n`;
}
