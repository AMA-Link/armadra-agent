/** [#318] 工作流文件的解析与格式化（§5.7）。[M1 桩，M5 实现] */
import { AmaError } from "../errors.js";
import type { WorkflowDocument, WorkflowFileParse } from "./types.js";

export function parseWorkflowFile(_text: string): WorkflowFileParse {
  throw new AmaError("not_implemented", "parseWorkflowFile is not implemented yet");
}

/** 只写文档里有的字段。 */
export function formatWorkflowFile(_w: WorkflowDocument): string {
  throw new AmaError("not_implemented", "formatWorkflowFile is not implemented yet");
}
