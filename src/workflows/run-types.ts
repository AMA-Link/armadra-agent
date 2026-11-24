/**
 * [#318] 工作流运行期类型（多 Agent 工作流设计稿 §5.6）：文件包装、运行状态、调度器所需的
 * 会话能力与宿主交接。可以 import 运行期类型（`tools/types.ts`），不从 `./workflow` 入口导出。
 */

import type { SubagentRequest, SubagentResult, TaskInfo } from "../tools/types.js";
import type { WorkflowDocument, WorkflowParam, WorkflowStepKind } from "./types.js";

export const WORKFLOW_CUSTOM_TYPE = "ama.workflow";
export type WorkflowScope = "project" | "user" | "config";
/** discover.ts 包出来的文件。 */
export interface WorkflowFile {
  readonly id: string;
  readonly scope: WorkflowScope;
  readonly filePath: string;
  readonly workflow: WorkflowDocument;
  /** 文件全文 sha256（hex）。 */
  readonly hash: string;
}
export interface WorkflowSummary {
  id: string;
  scope: WorkflowScope;
  filePath: string;
  title?: string;
  roles?: number;
  steps?: number;
  params?: readonly WorkflowParam[];
  valid: boolean;
  error?: string;
}

export const WORKFLOW_RUN_STATUSES = [
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];
export const WORKFLOW_STEP_STATUSES = [
  "pending",
  "running",
  "waiting",
  "done",
  "failed",
  "skipped",
  "cancelled",
] as const;
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];
export const WORKFLOW_STEP_PHASES = [
  "running",
  "waiting_children",
  "collecting",
  "verifying",
  "waiting_human",
] as const;
export type WorkflowStepPhase = (typeof WORKFLOW_STEP_PHASES)[number];
export type WorkflowGateDecision = "approve" | "reject";
export const WORKFLOW_ERROR_CODES = [
  "invalid_workflow",
  "workflow_not_found",
  "missing_param",
  "invalid_param",
  "prompt_too_long",
  "workflow_agent_unavailable",
  "workflow_busy",
  "gate_rejected",
  "gate_not_waiting",
  "verify_failed",
  "limit_reached",
  "step_failed",
  "interrupted",
  "cancelled",
  "workflow_exists",
  "workflow_unsupported",
  "workflow_file_changed",
  "workflow_handler_exists",
] as const;
export type WorkflowErrorCode = (typeof WORKFLOW_ERROR_CODES)[number];

export interface WorkflowStepState {
  id: string;
  kind: WorkflowStepKind;
  status: WorkflowStepStatus;
  phase?: WorkflowStepPhase;
  roleId?: string;
  taskId?: string;
  /** collect 的第几轮验证，从 1 起（画布叫 round，同义）。 */
  attempt?: number;
  startedAt?: number;
  endedAt?: number;
  outputFile?: string;
  decision?: WorkflowGateDecision;
  error?: string;
  warnings?: string[];
}
export interface WorkflowUpdate {
  runId: string;
  workflowId: string;
  title: string;
  status: WorkflowRunStatus;
  /** 已交给宿主执行。 */
  host: boolean;
  step?: WorkflowStepState;
}
export interface WorkflowRunResult {
  runId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  steps: readonly WorkflowStepState[];
  outputs: readonly { stepId: string; text: string }[];
  /** 交给宿主时宿主返回的运行 id 与画布链接。 */
  host?: { runId: string; url?: string };
  /** code 是 WorkflowErrorCode，或宿主返回的其它 code（原样）。 */
  error?: { code: WorkflowErrorCode | (string & {}); message: string };
}
/** custom `ama.workflow` 的 data（整条快照，后写覆盖前写）。 */
export interface WorkflowRunRecord {
  runId: string;
  workflowId: string;
  title: string;
  source: { scope: WorkflowScope; filePath?: string; hash?: string };
  params: Record<string, string>;
  status: WorkflowRunStatus;
  host?: { runId: string; url?: string };
  steps: WorkflowStepState[];
  startedAt: number;
  endedAt?: number;
  error?: WorkflowRunResult["error"];
}

export interface WorkflowGateRequest {
  runId: string;
  workflowId: string;
  stepId: string;
  label: string;
  /** 已完成步骤的一行摘要（report.summary 或结果首行）。 */
  completed: readonly { stepId: string; summary: string }[];
}
export type WorkflowGateAsker = (
  request: WorkflowGateRequest,
  signal: AbortSignal,
) => Promise<WorkflowGateDecision>;
export interface WorkflowVerifyFailure {
  runId: string;
  workflowId: string;
  stepId: string;
  reason: "exhausted" | "unverified" | "not_reopenable";
  summary: string;
  attempt: number;
}
export type WorkflowVerifyAsker = (
  failure: WorkflowVerifyFailure,
  signal: AbortSignal,
) => Promise<"accept" | "fail">;

export interface WorkflowRunOptions {
  params?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  onGate?: WorkflowGateAsker;
  /** 验证用尽 / 未验证 / 无法重开时问人；没有则 failed。 */
  onVerifyFailed?: WorkflowVerifyAsker;
  onUpdate?: (update: WorkflowUpdate) => void;
  /** 没有 onGate 时 gate 的处理；缺省 reject。不作用于验证失败。 */
  unattendedGate?: "reject" | "approve";
  /** 本次运行的上限（limits.* / --max-cost / --max-turns）。 */
  limits?: { maxCostUsd?: number; maxTurns?: number };
}

/** 调度器需要的会话能力（runner.ts 的 workflowHostOf 从 AgentSessionImpl 构造）。 */
export interface WorkflowHost {
  readonly sessionId: string;
  readonly cwd: string;
  spawn(request: SubagentRequest): Promise<SubagentResult>;
  /** 结果是 `status: "running"` 时等到终态。 */
  wait(taskId: string, signal: AbortSignal): Promise<SubagentResult>;
  tasks(): readonly TaskInfo[];
  /** 订阅本会话的 subagent_* 事件（阶段推导）；返回取消订阅。 */
  onTaskEvent(
    listener: (event: {
      type: string;
      taskId: string;
      parentTaskId?: string;
      status?: string;
    }) => void,
  ): () => void;
  /** 目录里有且可运行的 Agent（ama 类型名或外部 / 宿主 runner id）。 */
  agentAvailable(name: string): boolean;
  emit(update: WorkflowUpdate): void;
  record(data: WorkflowRunRecord): void;
  log(level: "info" | "warn", message: string): void;
}

export interface WorkflowRunHandle {
  readonly runId: string;
  readonly host: boolean;
  wait(): Promise<WorkflowRunResult>;
  /** 交给宿主的运行抛 workflow_unsupported。 */
  cancel(): Promise<void>;
  /** RPC respond_workflow_gate：gate 用 approve/reject，验证升级用 approve=accept / reject=fail；不在等返回 false。 */
  respondGate(stepId: string, decision: WorkflowGateDecision): boolean;
}

// ---- 宿主（HostApi.workflows，v1 只交出并起跑）----
export interface HostWorkflowRunRequest {
  /** 文件 id（必有；ama 不把内联草案交给宿主）。 */
  workflowId: string;
  workflow: WorkflowDocument;
  params: Readonly<Record<string, string>>;
  source: { scope: WorkflowScope; filePath: string; hash: string };
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
}
export interface HostWorkflowStarted {
  runId: string;
  /** 画布深链；可空。 */
  url?: string;
}
export interface HostWorkflowHandler {
  /** 宿主能执行的文件格式版本（Armadra：[2]）。 */
  readonly versions: readonly number[];
  /** 拒绝时抛带 `code`（如 workflow_unsupported、workflow_file_changed）与 message 的错误。 */
  run(request: HostWorkflowRunRequest): Promise<HostWorkflowStarted>;
}
