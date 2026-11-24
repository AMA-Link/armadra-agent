/** [#318] ama 自己调度的单独运行（§4.5、§5.7）。[M1 桩，M9 实现] */
import { AmaError } from "../errors.js";
import type {
  WorkflowFile,
  WorkflowHost,
  WorkflowRunHandle,
  WorkflowRunOptions,
} from "./run-types.js";
import type { WorkflowDocument } from "./types.js";

export function runStandalone(
  _host: WorkflowHost,
  _file: WorkflowFile | { workflow: WorkflowDocument },
  _options: WorkflowRunOptions,
): WorkflowRunHandle {
  throw new AmaError("not_implemented", "runStandalone is not implemented yet");
}
