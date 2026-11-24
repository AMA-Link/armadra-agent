/** [#318] 参数代入与缺省值补齐（§5.7）。[M1 桩，M5 实现] */
import { AmaError } from "../errors.js";
import type { CollectStep, NormalizedWorkflow, PromptStep, WorkflowDocument } from "./types.js";

export function normalizeWorkflow(_w: WorkflowDocument): NormalizedWorkflow {
  throw new AmaError("not_implemented", "normalizeWorkflow is not implemented yet");
}

export function resolveWorkflowParams(
  _w: WorkflowDocument,
  _given: Readonly<Record<string, unknown>>,
):
  | { ok: true; params: Record<string, string> }
  | { ok: false; code: "missing_param" | "invalid_param"; message: string } {
  throw new AmaError("not_implemented", "resolveWorkflowParams is not implemented yet");
}

export function renderWorkflowPrompt(
  _prompt: string,
  _params: Readonly<Record<string, string>>,
): string {
  throw new AmaError("not_implemented", "renderWorkflowPrompt is not implemented yet");
}

/** 2000 或 1800（§4.5 第 2 条）。 */
export function promptLimitOf(_w: WorkflowDocument, _step: PromptStep | CollectStep): number {
  throw new AmaError("not_implemented", "promptLimitOf is not implemented yet");
}

export function checkRenderedPrompts(
  _w: WorkflowDocument,
  _params: Readonly<Record<string, string>>,
): { stepId: string; limit: number } | undefined {
  throw new AmaError("not_implemented", "checkRenderedPrompts is not implemented yet");
}
