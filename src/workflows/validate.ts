/** [#318] 工作流校验（§5.7）。[M1 桩，M5 实现] */
import { AmaError } from "../errors.js";
import type { WorkflowValidation } from "./types.js";

/** 不补缺省值、不改写 glob。 */
export function validateWorkflow(_raw: unknown): WorkflowValidation {
  throw new AmaError("not_implemented", "validateWorkflow is not implemented yet");
}
