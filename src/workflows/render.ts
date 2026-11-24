/** [#318] 参数代入与缺省值补齐（多 Agent 工作流设计稿 §4.5 第 2 条、§5.7）。纯函数，属于 `./workflow` 入口。 */
import {
  WORKFLOW_DEFAULT_MAX_RETRIES,
  WORKFLOW_LIMITS,
  type CollectStep,
  type NormalizedWorkflow,
  type PromptStep,
  type WorkflowDocument,
} from "./types.js";

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** 补齐缺省值，只给调度器用，不写回文件。`maxRetries` 只含带 `verify` 的 collect 步骤。 */
export function normalizeWorkflow(w: WorkflowDocument): NormalizedWorkflow {
  const after = new Map<string, readonly string[]>();
  const maxRetries = new Map<string, number>();
  for (const step of w.steps) {
    after.set(step.id, step.after ?? []);
    if (step.kind === "collect" && step.verify != null) {
      maxRetries.set(step.id, step.maxRetries ?? WORKFLOW_DEFAULT_MAX_RETRIES);
    }
  }
  return {
    document: w,
    params: (w.params ?? []).map((p) => ({ ...p, type: p.type ?? "string" })),
    links: (w.links ?? []).map((l) => ({ ...l, role: l.role ?? "peer" })),
    after,
    maxRetries,
  };
}

const length = (s: string): number => [...s].length;

/** 起跑时给的参数：按声明补缺省、拒未知、拒缺、拒超长；值一律是字符串。 */
export function resolveWorkflowParams(
  w: WorkflowDocument,
  given: Readonly<Record<string, unknown>>,
):
  | { ok: true; params: Record<string, string> }
  | { ok: false; code: "missing_param" | "invalid_param"; message: string } {
  const declared = new Map((w.params ?? []).map((p) => [p.name, p]));
  for (const name of Object.keys(given)) {
    if (!declared.has(name)) {
      return { ok: false, code: "invalid_param", message: `Workflow has no parameter ${name}.` };
    }
  }
  const params: Record<string, string> = {};
  for (const [name, param] of declared) {
    const value = given[name] ?? param.default ?? undefined;
    if (value === undefined || value === null || value === "") {
      return { ok: false, code: "missing_param", message: `Parameter ${name} has no value.` };
    }
    if (typeof value !== "string") {
      return { ok: false, code: "invalid_param", message: `Parameter ${name} must be a string.` };
    }
    if (length(value) > WORKFLOW_LIMITS.paramValue) {
      return {
        ok: false,
        code: "invalid_param",
        message: `Parameter ${name} is longer than ${WORKFLOW_LIMITS.paramValue} characters.`,
      };
    }
    params[name] = value;
  }
  return { ok: true, params };
}

/** `{{name}}` 换成参数值；没声明的名字原样保留（提示词里的字面量）。 */
export function renderWorkflowPrompt(
  prompt: string,
  params: Readonly<Record<string, string>>,
): string {
  return prompt.replace(PLACEHOLDER, (whole, name: string) =>
    Object.hasOwn(params, name) ? params[name]! : whole,
  );
}

/** 代入后长度上限：collect 与有 contract 的 prompt 步骤 1800（预留 200），其余 2000。 */
export function promptLimitOf(w: WorkflowDocument, step: PromptStep | CollectStep): number {
  const contracted =
    step.kind === "collect" ||
    (w.contract?.text ?? "") !== "" ||
    (w.contract?.owns?.[step.role]?.length ?? 0) > 0;
  return WORKFLOW_LIMITS.prompt - (contracted ? WORKFLOW_LIMITS.reserve : 0);
}

/** 每步代入后都不超长（按码点）；返回第一个超长的步骤。 */
export function checkRenderedPrompts(
  w: WorkflowDocument,
  params: Readonly<Record<string, string>>,
): { stepId: string; limit: number } | undefined {
  for (const step of w.steps) {
    if (step.kind === "gate") continue;
    const limit = promptLimitOf(w, step);
    if (length(renderWorkflowPrompt(step.prompt, params)) > limit) {
      return { stepId: step.id, limit };
    }
  }
  return undefined;
}
