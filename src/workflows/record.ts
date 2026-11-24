/** [#318] 运行记录：调度器状态、快照与会话重建（§4.5 第 11–12 条、§5.7）。 */
import type { SessionEntry } from "../session/types.js";
import {
  WORKFLOW_CUSTOM_TYPE,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
  type WorkflowStepState,
} from "./run-types.js";

/** 调度器的运行状态；与 `WorkflowRunRecord` 同形，快照是它的深拷贝。 */
export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  title: string;
  source: WorkflowRunRecord["source"];
  params: Record<string, string>;
  status: WorkflowRunStatus;
  host?: { runId: string; url?: string };
  steps: WorkflowStepState[];
  startedAt: number;
  endedAt?: number;
  error?: WorkflowRunRecord["error"];
}

export function cloneStep(step: WorkflowStepState): WorkflowStepState {
  return { ...step, ...(step.warnings === undefined ? {} : { warnings: [...step.warnings] }) };
}

/** 整条快照（后写覆盖前写）；与状态不共享引用。 */
export function runRecordOf(state: WorkflowRunState): WorkflowRunRecord {
  return {
    runId: state.runId,
    workflowId: state.workflowId,
    title: state.title,
    source: { ...state.source },
    params: { ...state.params },
    status: state.status,
    ...(state.host === undefined ? {} : { host: { ...state.host } }),
    steps: state.steps.map(cloneStep),
    startedAt: state.startedAt,
    ...(state.endedAt === undefined ? {} : { endedAt: state.endedAt }),
    ...(state.error === undefined ? {} : { error: { ...state.error } }),
  };
}

function isRecord(data: unknown): data is WorkflowRunRecord {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Partial<WorkflowRunRecord>;
  return typeof d.runId === "string" && typeof d.status === "string" && Array.isArray(d.steps);
}

/**
 * 最后一条快照未结束（`running` / `waiting`）的运行，按首次出现的顺序。交给宿主的运行
 * （带 `host`）与等宿主确认的 `workflow_unsupported` 不由 ama 收尾，不在其中。
 */
export function rebuildWorkflowRuns(entries: readonly SessionEntry[]): WorkflowRunRecord[] {
  const last = new Map<string, WorkflowRunRecord>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== WORKFLOW_CUSTOM_TYPE) continue;
    if (isRecord(entry.data)) last.set(entry.data.runId, entry.data);
  }
  return [...last.values()].filter(
    (r) =>
      (r.status === "running" || r.status === "waiting") &&
      r.host === undefined &&
      r.error?.code !== "workflow_unsupported",
  );
}

function withoutPhase(step: WorkflowStepState): WorkflowStepState {
  const { phase: _phase, ...rest } = step;
  return rest;
}

/** resume 时追加的终态快照：运行 failed、未结束步骤 cancelled、`interrupted`。 */
export function interruptedRecordOf(record: WorkflowRunRecord, now: number): WorkflowRunRecord {
  return {
    ...record,
    status: "failed",
    endedAt: now,
    error: { code: "interrupted", message: "The run was interrupted when the session ended." },
    steps: record.steps.map((s) =>
      s.status === "pending" || s.status === "running" || s.status === "waiting"
        ? withoutPhase({ ...cloneStep(s), status: "cancelled", endedAt: now })
        : cloneStep(s),
    ),
  };
}
