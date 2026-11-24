/**
 * [#318] 工作流文档类型（多 Agent 工作流设计稿 §5.6）：文件 frontmatter / 画布草案 JSON
 * （Armadra WorkflowDraft 超集）。纯类型与常量，只 import 类型，属于 `./workflow` 入口。
 *
 * 文档类型按文件原样：可省略的字段都是可选，解析不补缺省值；运行时要缺省值用 `render.ts` 的 `normalizeWorkflow()`。
 */

import type { TierName } from "../agents/tier-ladder.js";

/** 格式号（不是修订号）；只认、只写 2。 */
export const WORKFLOW_FORMAT_VERSION = 2 as const;

export const WORKFLOW_STEP_KINDS = ["prompt", "collect", "gate"] as const;
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];
export const WORKFLOW_PARAM_TYPES = ["string", "path", "text"] as const;
export type WorkflowParamType = (typeof WORKFLOW_PARAM_TYPES)[number];
export const WORKFLOW_PERMISSION_MODES = ["default", "auto-edit", "full-auto", "plan"] as const;
export type WorkflowPermissionMode = (typeof WORKFLOW_PERMISSION_MODES)[number];

export const WORKFLOW_LIMITS = {
  title: 160,
  label: 160,
  params: 32,
  roles: 8,
  links: 32,
  steps: 32,
  /** 代入参数后的提示上限（码点数）。 */
  prompt: 2_000,
  /** collect 步骤与有 contract 时的 prompt 步骤预留。 */
  reserve: 200,
  model: 120,
  worktree: 200,
  paramValue: 2_000,
  draftBytes: 64 * 1024,
  contractText: 6_000,
  ownsPerRole: 16,
  glob: 200,
  verifyCommands: 4,
  checklist: 16,
  verifyItem: 300,
  maxRetries: 3,
  description: 4_000,
} as const;
export const WORKFLOW_DEFAULT_MAX_RETRIES = 2;

export const WORKFLOW_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const WORKFLOW_PARAM_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** `acp:` 只在 ama 单独运行有效，Armadra 导入时报 invalid_draft；`custom:` 后缀与 Armadra 一致（1–64 个非换行字符）。 */
export const WORKFLOW_AGENT_ID_PATTERN =
  /^(?:[a-z][a-z0-9-]{0,63}|custom:[^\r\n]{1,64}|acp:\S{1,128})$/;

export interface WorkflowParam {
  readonly name: string;
  /** 缺省 string（不写回）。 */
  readonly type?: WorkflowParamType | null;
  readonly label?: string | null;
  readonly default?: string | null;
}
export interface WorkflowRole {
  readonly id: string;
  readonly agentId: string;
  readonly title?: string | null;
  readonly permissionMode?: WorkflowPermissionMode | null;
  readonly model?: string | null;
  readonly worktree?: string | null;
  /** v2 */
  readonly tier?: TierName | null;
}
export interface WorkflowLink {
  readonly from: string;
  readonly to: string;
  /** 缺省 peer（不写回）。 */
  readonly role?: "peer" | "supervises" | null;
}
export interface WorkflowVerify {
  readonly commands?: readonly string[] | null;
  readonly checklist?: readonly string[] | null;
}
export interface PromptStep {
  readonly id: string;
  readonly kind: "prompt";
  readonly role: string;
  readonly prompt: string;
  /** 缺省 []（不写回）。 */
  readonly after?: readonly string[] | null;
}
export interface CollectStep {
  readonly id: string;
  readonly kind: "collect";
  readonly role: string;
  readonly from: readonly string[];
  readonly prompt: string;
  readonly after?: readonly string[] | null;
  /** v2 */
  readonly verify?: WorkflowVerify | null;
  /** v2：0–3，缺省 WORKFLOW_DEFAULT_MAX_RETRIES（不写回）；只允许与 verify 同给。 */
  readonly maxRetries?: number | null;
}
export interface GateStep {
  readonly id: string;
  readonly kind: "gate";
  readonly label: string;
  readonly after?: readonly string[] | null;
}
export type WorkflowStep = PromptStep | CollectStep | GateStep;

export interface WorkflowContract {
  /** 接口与约束，原样发给每个角色。 */
  readonly text?: string | null;
  /** roleId → glob[]（方言见 §4.2；原样保存，不规整）。 */
  readonly owns?: Readonly<Record<string, readonly string[]>> | null;
}
export interface WorkflowSourceInfo {
  readonly boardId?: string | null;
  readonly nodeIds?: readonly string[] | null;
  readonly proposedBy?: string | null;
  readonly sessionId?: string | null;
}
/** 文件 frontmatter / 画布草案 JSON（Armadra WorkflowDraft 超集）。 */
export interface WorkflowDocument {
  readonly version: typeof WORKFLOW_FORMAT_VERSION;
  readonly title: string;
  /** v2：md 正文（给人看，不发给模型）。 */
  readonly description?: string | null;
  readonly params?: readonly WorkflowParam[] | null;
  readonly roles: readonly WorkflowRole[];
  readonly links?: readonly WorkflowLink[] | null;
  readonly steps: readonly WorkflowStep[];
  /** v2 */
  readonly contract?: WorkflowContract | null;
  readonly source?: WorkflowSourceInfo | null;
}
export interface WorkflowIssue {
  readonly path: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}
export type WorkflowValidation =
  | { ok: true; workflow: WorkflowDocument; warnings: WorkflowIssue[] }
  | { ok: false; errors: WorkflowIssue[]; warnings: WorkflowIssue[] };
/** parseWorkflowFile 的结果（纯函数，不知道 id 与路径）。 */
export interface WorkflowFileParse {
  workflow?: WorkflowDocument;
  issues: WorkflowIssue[];
}
/** normalizeWorkflow 的结果：缺省值补齐，只给调度器用，不写回文件。 */
export interface NormalizedWorkflow {
  readonly document: WorkflowDocument;
  readonly params: readonly (WorkflowParam & { type: WorkflowParamType })[];
  readonly links: readonly (WorkflowLink & { role: "peer" | "supervises" })[];
  readonly after: ReadonlyMap<string, readonly string[]>;
  readonly maxRetries: ReadonlyMap<string, number>;
}
