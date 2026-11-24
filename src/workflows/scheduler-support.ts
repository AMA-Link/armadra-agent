/** [#318] 调度器的纯辅助：内部异常、判定、运行预算、子任务查找（§4.5）。 */
import type { SubagentResult, TaskInfo } from "../tools/types.js";

export class StepFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class Cancelled extends Error {}

export const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type VerdictKind = "ok" | "task_failed" | "report_failed" | "no_report";

/** 终态非 completed 或报错 → task_failed；有 report：ready 通过、waiting 当没报、failed / blocked 不通过。 */
export function verdictOf(r: SubagentResult): { kind: VerdictKind; reason: string } {
  const failedStatus = (r.status !== undefined && r.status !== "completed") || r.isError;
  const reason =
    r.report?.summary || firstLine(r.text) || `task ended with status ${r.status ?? "error"}`;
  if (failedStatus) return { kind: "task_failed", reason };
  if (r.report === undefined) return { kind: "no_report", reason };
  if (r.report.state === "ready") return { kind: "ok", reason };
  if (r.report.state === "waiting") return { kind: "no_report", reason };
  return { kind: "report_failed", reason: r.report.summary };
}

/** 有没有在跑的任务，其 `parentTaskId` 链指向 `taskId`。 */
export function hasRunningChild(tasks: readonly TaskInfo[], taskId: string): boolean {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  return tasks.some((t) => {
    if (t.status !== "running" || t.taskId === taskId) return false;
    for (let p = t.parentTaskId, hops = 0; p !== undefined && hops < 16; hops++) {
      if (p === taskId) return true;
      p = byId.get(p)?.parentTaskId;
    }
    return false;
  });
}

/** 本次运行的花费 / 轮数：带本运行 `workflow.runId` 的任务及其 `parentTaskId` 链下的后代。 */
export function budgetMessage(
  tasks: readonly TaskInfo[],
  runId: string,
  limits: { maxCostUsd?: number; maxTurns?: number } | undefined,
): string | undefined {
  const { maxCostUsd, maxTurns } = limits ?? {};
  if (maxCostUsd === undefined && maxTurns === undefined) return undefined;
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const mine = (id: string | undefined, hops = 0): boolean => {
    const t = id === undefined ? undefined : byId.get(id);
    if (t === undefined || hops > 16) return false;
    return t.workflow?.runId === runId || mine(t.parentTaskId, hops + 1);
  };
  let cost = 0;
  let turns = 0;
  for (const t of tasks) {
    if (!mine(t.taskId)) continue;
    cost += t.costUsd ?? 0;
    turns += t.turns ?? 0;
  }
  if (maxCostUsd !== undefined && cost >= maxCostUsd) {
    return `The workflow run reached the $${maxCostUsd.toFixed(2)} cost limit ($${cost.toFixed(2)} spent).`;
  }
  if (maxTurns !== undefined && turns >= maxTurns) {
    return `The workflow run reached the ${maxTurns}-turn limit.`;
  }
  return undefined;
}
