/**
 * ApprovalBroker 链（设计 §6.3 第 4 步、§7.1）。[B3]
 *
 * - 回答者顺序：宿主 broker（`HostApi.approvals.setBroker`）→ UI broker（TUI 对话框 / RPC 客户端 /
 *   SDK 回调）→ 无人值守 deny。回答者返回 undefined 表示交给下一个；抛错按 deny（fail-safe）。
 * - 超时（缺省 10 min）→ deny；父 signal abort → deny。
 * - 审批**串行化**：同一时刻只有一个请求在等回答（task 子 Agent 的审批排到父对话框之后）。
 * - `allow_session` → 调 `pipeline.rememberForSession()` 后放行。
 * - `authorize()`：管线判定 + 需要时走 broker，给 tool-runner（B2）一个单入口。
 *
 * [#271] 切换权限模式时重判待审批（`reevaluatePending`）：对正在等 UI 回答的与排队中的请求，按
 * `request.reevaluation.check()`（同一条管线、新模式）重判——allow / deny 直接结算，ask 保持不动。
 * 不碰：宿主 broker 已接手的（正在等宿主回答）、没有 `reevaluation` 的（外部 Agent 的请求、首次运行确认）。
 * 结算是同步且幂等的：先到的回答为准；结算时 abort 该请求自己的 `cancel` 信号，UI 对话框 / RPC / ACP 的挂起
 * 请求随之撤回。已结算的排队项轮到时直接返回，不再开对话框。
 */

import { randomUUID } from "node:crypto";
import type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalReason,
  ApprovalRequest,
  PermissionCheckInput,
  PermissionMode,
  PermissionPipelineApi,
  PermissionVerdict,
} from "./types.js";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export interface BrokerChainOptions {
  timeoutMs?: number;
  onRequested?(request: ApprovalRequest): void;
  onResolved?(request: ApprovalRequest, decision: ApprovalDecision, by: AnsweredBy): void;
  log?(level: "debug" | "info" | "warn", message: string): void;
}

/** `mode`：被权限模式切换自动作答（[#271]）。 */
export type AnsweredBy = "host" | "ui" | "timeout" | "aborted" | "unattended" | "error" | "mode";

/** [#271] 一次重判的结果：被自动放行 / 拒绝的请求。 */
export interface ReevaluationSummary {
  allowed: ApprovalRequest[];
  denied: ApprovalRequest[];
}

interface Entry {
  request: ApprovalRequest;
  /** 还在排队 / 正在问哪位回答者。 */
  stage: "queued" | "host" | "ui";
  /** 建立时的模式纪元；与链当前纪元不同说明中途切过模式（晚判用）。 */
  epoch: number;
  settled?: { decision: ApprovalDecision; by: AnsweredBy };
  /** 结算时 abort：关掉正在等的 UI。 */
  cancel: AbortController;
  resolve(decision: ApprovalDecision): void;
  promise: Promise<ApprovalDecision>;
}

export class ApprovalBrokerChain {
  private host: ApprovalBroker | undefined;
  private ui: ApprovalBroker | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly entries: Entry[] = [];
  /** 模式纪元与最近一次切到的模式（晚判写 outcome 用）。 */
  private epoch = 0;
  private mode: PermissionMode | undefined;

  constructor(private readonly options: BrokerChainOptions = {}) {}

  setHostBroker(broker: ApprovalBroker | undefined): void {
    this.host = broker;
  }

  setUiBroker(broker: ApprovalBroker | undefined): void {
    this.ui = broker;
  }

  /** 有没有可能回答的人；没有则调用方应按无人值守处理。 */
  hasResponder(): boolean {
    return this.host !== undefined || this.ui !== undefined;
  }

  /** 还没结算的请求数（在等的 + 排队的）。 */
  get pendingCount(): number {
    return this.entries.length;
  }

  /** 串行排队后询问；总会给出决定。已被模式切换结算的排队项不再询问。 */
  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    let resolve!: (decision: ApprovalDecision) => void;
    const promise = new Promise<ApprovalDecision>((r) => (resolve = r));
    const entry: Entry = {
      request,
      stage: "queued",
      epoch: this.epoch,
      cancel: new AbortController(),
      resolve,
      promise,
    };
    this.entries.push(entry);
    const run = this.queue.then(() =>
      entry.settled !== undefined ? entry.settled.decision : this.askNow(entry, signal),
    );
    this.queue = run.catch(() => undefined);
    return Promise.race([promise, run]);
  }

  /**
   * [#271] 模式切换：按新模式重判在等的与排队的请求。只结算 allow / deny；ask 不动。
   * 宿主已接手、没有 `reevaluation` 的请求跳过。
   */
  reevaluatePending(mode: PermissionMode): ReevaluationSummary {
    this.epoch++;
    this.mode = mode;
    const summary: ReevaluationSummary = { allowed: [], denied: [] };
    for (const entry of [...this.entries]) {
      if (entry.settled !== undefined || entry.stage === "host") continue;
      const decided = this.decideByMode(entry, mode);
      if (decided === undefined) continue;
      (decided === "allow" ? summary.allowed : summary.denied).push(entry.request);
    }
    return summary;
  }

  /** 重判一条：allow / deny 结算并返回结论；ask 或无法重判返回 undefined。 */
  private decideByMode(entry: Entry, mode: PermissionMode): "allow" | "deny" | undefined {
    const reevaluation = entry.request.reevaluation;
    if (reevaluation === undefined) return undefined;
    let verdict: PermissionVerdict;
    try {
      verdict = reevaluation.check();
    } catch (err) {
      this.options.log?.("warn", `approval re-evaluation failed: ${(err as Error).message}`);
      return undefined;
    }
    if (verdict.decision === "ask") return undefined;
    const outcome: NonNullable<typeof reevaluation.outcome> = { mode, decision: verdict.decision };
    if (verdict.message !== undefined) outcome.message = verdict.message;
    reevaluation.outcome = outcome;
    this.settle(entry, verdict.decision, "mode");
    return verdict.decision;
  }

  /** 幂等结算：记结论、出表、撤回 UI、回调、兑现 promise。 */
  private settle(entry: Entry, decision: ApprovalDecision, by: AnsweredBy): void {
    if (entry.settled !== undefined) return;
    entry.settled = { decision, by };
    const at = this.entries.indexOf(entry);
    if (at >= 0) this.entries.splice(at, 1);
    entry.cancel.abort();
    this.options.onResolved?.(entry.request, decision, by);
    entry.resolve(decision);
  }

  private async askNow(entry: Entry, signal: AbortSignal): Promise<ApprovalDecision> {
    const { request } = entry;
    this.options.onRequested?.(request);
    const finish = (decision: ApprovalDecision, by: AnsweredBy): ApprovalDecision => {
      this.settle(entry, decision, by);
      return entry.settled!.decision;
    };
    if (signal.aborted) return finish("deny", "aborted");
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(),
      this.options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    );
    const combined = AbortSignal.any([signal, timeout.signal, entry.cancel.signal]);
    const stopped = new Promise<"stopped">((resolve) => {
      if (combined.aborted) resolve("stopped");
      combined.addEventListener("abort", () => resolve("stopped"), { once: true });
    });
    try {
      const responders: ["host" | "ui", ApprovalBroker | undefined][] = [
        ["host", this.host],
        ["ui", this.ui],
      ];
      for (const [by, broker] of responders) {
        if (!broker) continue;
        // 中途切过模式（排队时、等宿主时）：问下一位之前先按新模式补判一次
        if (entry.epoch !== this.epoch && this.mode !== undefined) {
          entry.epoch = this.epoch;
          if (this.decideByMode(entry, this.mode) !== undefined) return entry.settled!.decision;
        }
        entry.stage = by;
        let answer: ApprovalDecision | undefined | "stopped";
        try {
          answer = await Promise.race([broker.ask(request, combined), stopped]);
        } catch (err) {
          this.options.log?.("warn", `approval broker (${by}) failed: ${(err as Error).message}`);
          return finish("deny", "error");
        }
        if (entry.settled !== undefined) return entry.settled.decision;
        if (answer === "stopped") return finish("deny", signal.aborted ? "aborted" : "timeout");
        if (answer === "allow" || answer === "deny" || answer === "allow_session") {
          return finish(answer, by);
        }
      }
      return finish("deny", "unattended");
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * [#271] `setPermissionMode` 的入口：对会话 `brokers` 里的链重判待审批，返回自动放行 / 拒绝的条数。
 * 子会话的 broker 是包装过的（不是链），不改模式，所以这里只认链本身。
 */
export function reevaluatePendingApprovals(
  brokers: readonly ApprovalBroker[] | undefined,
  mode: PermissionMode,
): { allowed: number; denied: number } {
  let allowed = 0;
  let denied = 0;
  for (const broker of brokers ?? []) {
    if (!(broker instanceof ApprovalBrokerChain)) continue;
    const summary = broker.reevaluatePending(mode);
    allowed += summary.allowed.length;
    denied += summary.denied.length;
  }
  return { allowed, denied };
}

export interface AuthorizeResult {
  allowed: boolean;
  verdict: PermissionVerdict;
  /** 走了 broker 时的回答。 */
  decision?: ApprovalDecision;
  /** 拒绝时给 tool_result 的说明。 */
  message?: string;
}

export interface AuthorizeOptions {
  signal: AbortSignal;
  requestId?: string;
}

/** 管线 + broker 的单入口。`input.unattended` 由调用方按「是否有回答者」等决定。 */
export async function authorize(
  pipeline: PermissionPipelineApi,
  chain: ApprovalBrokerChain,
  input: PermissionCheckInput,
  options: AuthorizeOptions,
): Promise<AuthorizeResult> {
  const verdict = pipeline.check(input);
  if (verdict.decision === "allow") return { allowed: true, verdict };
  if (verdict.decision === "deny") {
    return { allowed: false, verdict, message: verdict.message ?? "Permission denied" };
  }
  const reason: ApprovalReason = verdict.approvalReason ?? "mode";
  const request: ApprovalRequest = {
    requestId: options.requestId ?? randomUUID(),
    toolName: input.toolName,
    input: input.input,
    reason,
    reevaluation: { check: () => pipeline.check(input) },
  };
  const hookReason = reason === "hook" ? (input.hookReason ?? verdict.message) : undefined;
  if (hookReason !== undefined) request.hookReason = hookReason;
  const decision = await chain.ask(request, options.signal);
  if (decision === "allow_session") pipeline.rememberForSession(input.toolName, input.input);
  if (decision === "deny") {
    return { allowed: false, verdict, decision, message: "The tool call was not approved." };
  }
  return { allowed: true, verdict, decision };
}
