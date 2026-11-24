/**
 * [#318] `@armadra/agent/workflow` 公开入口：工作流文档类型与纯函数（校验、渲染、文件格式、glob、JSON Schema）。
 * 只导出纯函数，不读写文件；import 图由 `src/workflows/entry-purity.test.ts` 守住。
 */
export * from "./workflows/types.js";
export { validateWorkflow } from "./workflows/validate.js";
export { resolveWorkflowParams, renderWorkflowPrompt } from "./workflows/render.js";
export { parseWorkflowFile, formatWorkflowFile } from "./workflows/file.js";
export { validateOwnsGlob, globsOverlap } from "./workflows/glob.js";
export { workflowJsonSchema } from "./workflows/json-schema.js";
