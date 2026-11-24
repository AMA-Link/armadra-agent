/** [#318] 工作流 JSON Schema（§5.7）。[M1 桩，M5 实现] */
import { AmaError } from "../errors.js";

export function workflowJsonSchema(): Record<string, unknown> {
  throw new AmaError("not_implemented", "workflowJsonSchema is not implemented yet");
}
