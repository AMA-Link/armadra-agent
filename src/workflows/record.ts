/** [#318] 运行记录：快照与会话重建（§5.7）。[M1 桩，M9 实现] */
import { AmaError } from "../errors.js";
import type { SessionEntry } from "../session/types.js";
import type { WorkflowRunRecord } from "./run-types.js";

/** `state` 的形状由 M9 的调度器定义；契约只固定返回值。 */
export function runRecordOf(_state: unknown): WorkflowRunRecord {
  throw new AmaError("not_implemented", "runRecordOf is not implemented yet");
}

/** 最后一条快照未结束的运行。 */
export function rebuildWorkflowRuns(_entries: readonly SessionEntry[]): WorkflowRunRecord[] {
  throw new AmaError("not_implemented", "rebuildWorkflowRuns is not implemented yet");
}
