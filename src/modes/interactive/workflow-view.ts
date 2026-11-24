/**
 * `/workflow` 的文本呈现：列表、详情、运行预览与进度行（纯函数，界面文案全部来自 `msg().workflows`）。[#318]
 */

import { TYPICAL_TASK_TOKENS, tierCostRows } from "../../agents/tier-cost.js";
import type { TierTable } from "../../agents/tier-ladder.js";
import type { Model } from "../../ai/types.js";
import { msg } from "../../i18n/index.js";
import type { WorkflowDiscovery } from "../../workflows/discover.js";
import type { WorkflowFile, WorkflowRunStatus, WorkflowUpdate } from "../../workflows/run-types.js";
import type { WorkflowDocument, WorkflowRole } from "../../workflows/types.js";

export interface RoleTargets {
  tiers: TierTable | undefined;
  findModel(ref: string): Model | undefined;
}

export function scopeText(scope: WorkflowFile["scope"]): string {
  return msg().workflows.scope[scope];
}

export function listLines(found: WorkflowDiscovery): string[] {
  const m = msg().workflows;
  const lines: string[] = [];
  for (const s of found.summaries) {
    lines.push(
      s.valid
        ? m.list.line(s.id, s.title ?? s.id, s.steps ?? 0, scopeText(s.scope))
        : m.list.invalid(s.filePath, s.error ?? ""),
    );
  }
  for (const dir of found.skippedUntrusted) lines.push(m.list.untrusted(dir));
  return lines.length === 0 ? [m.list.empty] : lines;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;
const typical = (m: Model): number | undefined =>
  m.cost === undefined
    ? undefined
    : m.cost.input === 0 && m.cost.output === 0
      ? undefined
      : (TYPICAL_TASK_TOKENS.input * m.cost.input + TYPICAL_TASK_TOKENS.output * m.cost.output) /
        1_000_000;

/** 角色的目标（显式模型 > 档位 > Agent 本身）与每步的典型花费。 */
export function roleTarget(
  role: WorkflowRole,
  targets: RoleTargets,
): { target: string; usd?: number } {
  if (role.model !== undefined && role.model !== null) {
    const found = targets.findModel(role.model);
    const cost = found === undefined ? undefined : typical(found);
    return { target: role.model, ...(cost === undefined ? {} : { usd: cost }) };
  }
  if (role.tier !== undefined && role.tier !== null) {
    const row = tierCostRows(targets.tiers, targets.findModel).find((r) => r.tier === role.tier);
    if (row !== undefined && row.kind !== "inherit")
      return {
        target: row.target,
        ...(row.typicalTaskUsd === undefined ? {} : { usd: row.typicalTaskUsd }),
      };
  }
  return { target: role.agentId };
}

function roleLine(role: WorkflowRole, targets: RoleTargets, withCost: boolean): string {
  const m = msg().workflows;
  const { target, usd: cost } = roleTarget(role, targets);
  const head = m.preview.role(role.id, target, role.tier ?? undefined);
  if (!withCost) return head;
  return `${head}  ${cost === undefined ? m.preview.noCost : m.preview.cost(usd(cost))}`;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/** 运行预览：每个角色一行、步骤数与关口数。 */
export function previewLines(
  workflow: WorkflowDocument,
  params: Readonly<Record<string, string>>,
  targets: RoleTargets,
): string[] {
  const m = msg().workflows;
  const gates = workflow.steps.filter((s) => s.kind === "gate").length;
  return [
    workflow.title,
    ...Object.entries(params).map(([name, value]) => `${name}=${oneLine(value)}`),
    ...workflow.roles.map((r) => roleLine(r, targets, true)),
    m.preview.summary(workflow.steps.length, gates),
  ];
}

/** `/workflow show`：参数、角色、步骤图、契约、正文。 */
export function showLines(file: WorkflowFile, targets: RoleTargets): string[] {
  const m = msg().workflows;
  const w = file.workflow;
  const lines = [m.list.line(file.id, w.title, w.steps.length, scopeText(file.scope))];
  const params = w.params ?? [];
  if (params.length > 0) {
    lines.push("", m.show.params);
    for (const p of params) {
      const label = p.label === undefined || p.label === null ? "" : `  ${p.label}`;
      const dflt = p.default === undefined || p.default === null ? "" : ` = ${oneLine(p.default)}`;
      lines.push(`  ${p.name} (${p.type ?? "string"})${dflt}${label}`);
    }
  }
  lines.push("", m.show.roles);
  for (const r of w.roles) lines.push(`  ${roleLine(r, targets, false)}`);
  lines.push("", m.show.steps);
  for (const s of w.steps) {
    const who = s.kind === "gate" ? s.label : s.role;
    const after = s.after ?? [];
    lines.push(`  ${s.id} [${s.kind}] ${who}${after.length > 0 ? ` ← ${after.join(", ")}` : ""}`);
  }
  const contract = w.contract?.text;
  if (contract !== undefined && contract !== null && contract !== "")
    lines.push("", m.show.contract, ...contract.split("\n").map((l) => `  ${l}`));
  const description = w.description;
  if (description !== undefined && description !== null && description !== "")
    lines.push("", m.show.description, ...description.split("\n").map((l) => `  ${l}`));
  return lines;
}

export function statusText(status: WorkflowRunStatus): string {
  return msg().workflows.status[status];
}

/** 步骤变化的一行；没有 `step` 的整体状态更新返回 undefined。 */
export function stepProgressLine(update: WorkflowUpdate): string | undefined {
  const step = update.step;
  if (step === undefined) return undefined;
  const m = msg().workflows;
  const phase = step.phase === undefined ? "" : ` (${m.phase[step.phase]})`;
  return m.run.step(step.id, `${m.stepStatus[step.status]}${phase}`);
}
