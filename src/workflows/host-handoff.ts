/** [#318] 交给宿主执行（只交出并起跑，§4.6、§5.7）。[M1 桩，M12 实现] */
import { AmaError } from "../errors.js";
import type {
  HostWorkflowHandler,
  WorkflowFile,
  WorkflowHost,
  WorkflowRunHandle,
  WorkflowRunOptions,
} from "./run-types.js";

export function runOnHost(
  _handler: HostWorkflowHandler,
  _host: WorkflowHost,
  _file: WorkflowFile,
  _options: WorkflowRunOptions,
): WorkflowRunHandle {
  throw new AmaError("not_implemented", "runOnHost is not implemented yet");
}
