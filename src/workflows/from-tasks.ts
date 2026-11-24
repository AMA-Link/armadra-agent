/** [#318] 把本会话的子任务整理成工作流（§5.7）。[M1 桩，M10 实现] */
import { AmaError } from "../errors.js";
import type { TaskInfo } from "../tools/types.js";
import type { WorkflowDocument } from "./types.js";

export function workflowFromTasks(
  _tasks: readonly TaskInfo[],
  _prompts: ReadonlyMap<string, string>,
  _title: string,
): WorkflowDocument | undefined {
  throw new AmaError("not_implemented", "workflowFromTasks is not implemented yet");
}
