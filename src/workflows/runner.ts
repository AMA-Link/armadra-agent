/** [#318] 工作流入口：选单独运行还是交给宿主（§4.5–§4.6、§5.7）。[M1 桩，M12 实现] */
import { AmaError } from "../errors.js";
import type { AgentSessionImpl } from "../agent/session.js";
import type {
  HostWorkflowHandler,
  WorkflowFile,
  WorkflowHost,
  WorkflowRunHandle,
  WorkflowRunOptions,
} from "./run-types.js";
import type { WorkflowDocument } from "./types.js";

export function startWorkflow(
  _host: WorkflowHost,
  _file: WorkflowFile | { workflow: WorkflowDocument },
  _options: WorkflowRunOptions & { hostHandler?: HostWorkflowHandler },
): WorkflowRunHandle {
  throw new AmaError("not_implemented", "startWorkflow is not implemented yet");
}

export function workflowHostOf(_session: AgentSessionImpl): WorkflowHost {
  throw new AmaError("not_implemented", "workflowHostOf is not implemented yet");
}

export function activeWorkflow(_sessionId: string): WorkflowRunHandle | undefined {
  throw new AmaError("not_implemented", "activeWorkflow is not implemented yet");
}
