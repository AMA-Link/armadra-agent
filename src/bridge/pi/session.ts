/**
 * 一个 ACP 会话 = 一个 `pi --mode rpc --session-id <id>` 子进程（#254）。
 *
 * - 握手：`get_state`（当前模型、推理强度、消息数）、`get_available_models`、`get_available_thinking_levels`；
 *   没有可用模型 → `pi_no_model`；
 * - 回合：`prompt` → 应答 `disposition`（`handled` 不等回合）→ 事件流 → `agent_settled` 结束；
 *   `aborted` 为真或本端已取消 → `cancelled`；assistant 的 `stopReason` 为 `length` → `max_tokens`，`error` → JSON-RPC 错误；
 *   运行中再来的 prompt 答 busy；答复的 `usage` 是本回合累加；
 * - 取消：撤回挂起的审批与征询，发 `abort`，15 秒看门狗（过了关 stdin 再杀进程树）；
 * - 用量：开会话、回合结束与换模型之后发 `usage_update`（`get_session_stats` 的上下文占用与窗口、费用）。
 */

import { AmaError } from "../../errors.js";
import { armCancelWatchdog, type DriverDeps } from "../../drivers/base.js";
import {
  RPC_ERRORS,
  type AcpPromptResult,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionConfigOption,
  type AcpSessionModeState,
  type AcpSessionUpdate,
} from "../../drivers/acp/types.js";
import { RpcError } from "../../drivers/jsonrpc.js";
import { PiRpcCore } from "../../drivers/native/pi-rpc-core.js";
import {
  PI_GATE_TITLE,
  PI_REASON_TITLE,
  PI_STATUS_KEY,
} from "../../drivers/native/pi-extension.js";
import { stderrHint, type AgentTransport } from "../../drivers/process.js";
import { oneLine } from "../../drivers/turn.js";
import { msg } from "../../i18n/index.js";
import { permissionModeLabel } from "../../permissions/modes.js";
import type { PiVersionInfo } from "./capabilities.js";
import {
  CONFIG_IDS,
  buildConfigOptions,
  modelRefOf,
  modelValue,
  type ConfigState,
} from "./config.js";
import { PiEventMapper } from "./events.js";
import {
  BRIDGE_MODES,
  isBridgeMode,
  parseGateCall,
  verdictFor,
  type BridgeMode,
  type GateCall,
} from "./gate.js";
import { promptCommand } from "./prompt.js";
import { replayUpdates } from "./replay.js";
import type { Json } from "./tools.js";

export interface SessionInit {
  id: string;
  cwd: string;
  transport: AgentTransport;
  info: PiVersionInfo;
  /** `session/update`（带本会话 id）。 */
  emit(update: AcpSessionUpdate): void;
  /** stderr 一行诊断。 */
  log(message: string): void;
  /** 客户端给的 MCP 服务器名。 */
  mcpServers: readonly string[];
  deps?: Pick<DriverDeps, "cancelGraceMs" | "setTimer"> & { statusWaitMs?: number };
  /** `session/request_permission`：只发给客户端，桥从不代答；`signal` abort 时撤回请求。 */
  askPermission(
    params: AcpRequestPermissionParams,
    signal: AbortSignal,
  ): Promise<AcpRequestPermissionResult>;
  /** 关闭后清理（临时目录）。 */
  dispose(): void;
}

function asRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (error instanceof AmaError)
    return new RpcError(RPC_ERRORS.internalError, error.message, { code: error.code });
  return new RpcError(RPC_ERRORS.internalError, (error as Error).message);
}

const dataOf = (response: Json): Json => (response["data"] ?? {}) as Json;

export class PiBridgeSession {
  readonly core: PiRpcCore;
  readonly mapper: PiEventMapper;
  private id: string;
  private configState: ConfigState = { models: [], levels: [] };
  private messageCount = 0;
  private running: Promise<AcpPromptResult> | undefined;
  private settle: ((aborted: boolean) => void) | undefined;
  private readonly exitWaiters = new Set<(error: Error) => void>();
  private interrupted = false;
  private closed = false;
  private lastUsage: string | undefined;
  private mode: BridgeMode = "default";
  /** 挂起的 `session/request_permission`（取消与关闭时撤回）。 */
  private readonly asks = new Set<AbortController>();
  /** 桥自己拒绝的调用 → 回给模型的理由（扩展随后用 editor 对话框来取）。 */
  private readonly denials = new Map<string, string>();
  /** 扩展报告的工具名（`setStatus`）；没收到为 undefined。 */
  private tools: string[] | undefined;
  private resolveStatus: (() => void) | undefined;
  private readonly statusSeen = new Promise<void>((resolve) => (this.resolveStatus = resolve));

  constructor(private readonly init: SessionInit) {
    this.id = init.id;
    this.mapper = new PiEventMapper({
      cwd: init.cwd,
      emit: (update) => init.emit(update),
      mcpServers: () => init.mcpServers,
    });
    this.core = new PiRpcCore({
      transport: init.transport,
      commands: init.info.commands,
      onEvent: (record) => this.onRecord(record),
      onUiRequest: (record) => this.onUiRequest(record),
      onExit: (error) => this.onExit(error),
      exitMessage: (hint) => msg().bridge.pi.exited(hint),
      timeoutMessage: (command) => msg().bridge.pi.commandTimedOut(command),
    });
  }

  get sessionId(): string {
    return this.id;
  }

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  get existingMessages(): number {
    return this.messageCount;
  }

  /** 握手：取状态、模型与推理强度；没有可用模型抛 `pi_no_model`。 */
  async start(signal?: AbortSignal): Promise<void> {
    const aborted = new Promise<never>((_, reject) => {
      if (signal?.aborted === true) reject(new Error("aborted"));
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    void aborted.catch(() => undefined);
    const run = async (): Promise<void> => {
      const state = dataOf(await this.request({ type: "get_state" }));
      if (typeof state["sessionId"] === "string" && state["sessionId"] !== "")
        this.id = state["sessionId"];
      this.messageCount = typeof state["messageCount"] === "number" ? state["messageCount"] : 0;
      const models = dataOf(await this.request({ type: "get_available_models" }))["models"];
      const list = (Array.isArray(models) ? models : []).flatMap((m) => modelRefOf(m) ?? []);
      const current = modelRefOf(state["model"]);
      if (list.length === 0 && current === undefined)
        throw new RpcError(RPC_ERRORS.internalError, msg().bridge.pi.noModel, {
          code: "pi_no_model",
        });
      this.configState = {
        models: list,
        ...(current !== undefined ? { current } : {}),
        levels: [],
        ...(typeof state["thinkingLevel"] === "string" ? { level: state["thinkingLevel"] } : {}),
      };
      await this.refreshLevels();
      // 扩展的能力报告通常早于 get_state 的应答到达；没到就最多再等一小会儿
      await Promise.race([
        this.statusSeen,
        new Promise<void>((resolve) =>
          setTimeout(resolve, this.init.deps?.statusWaitMs ?? 300).unref(),
        ),
      ]);
    };
    try {
      await Promise.race([run(), aborted]);
    } catch (error) {
      throw asRpcError(error);
    }
  }

  private async request(command: Json): Promise<Json> {
    const response = await this.core.request(command);
    if (response["success"] !== true)
      throw new AmaError(
        "agent_failed",
        oneLine(String(response["error"] ?? `${String(command["type"])} failed`), 300),
      );
    return response;
  }

  private async refreshLevels(): Promise<void> {
    if (!this.init.info.capabilities.thinkingLevels) return;
    try {
      const levels = dataOf(await this.request({ type: "get_available_thinking_levels" }))[
        "levels"
      ];
      this.configState = {
        ...this.configState,
        levels: Array.isArray(levels)
          ? levels.filter((l): l is string => typeof l === "string")
          : [],
      };
    } catch {
      // 读不到就不给 thought_level 项
    }
  }

  configOptions(): AcpSessionConfigOption[] {
    return buildConfigOptions(this.configState);
  }

  /** `session/set_config_option`：返回全部配置项的新状态；换模型之后重取推理强度并发 `config_option_update`。 */
  async setConfigOption(id: string, value: string): Promise<AcpSessionConfigOption[]> {
    const m = msg().bridge.config;
    const state = this.configState;
    if (id === CONFIG_IDS.model) {
      const model = state.models.find((x) => modelValue(x) === value);
      if (model === undefined)
        throw new RpcError(RPC_ERRORS.invalidParams, m.invalidValue(id, value));
      await this.change(id, { type: "set_model", provider: model.provider, modelId: model.id });
      await this.syncState();
      await this.refreshLevels();
      const options = this.configOptions();
      this.init.emit({ sessionUpdate: "config_option_update", configOptions: options });
      void this.reportUsage();
      return options;
    }
    if (id === CONFIG_IDS.thoughtLevel) {
      if (!state.levels.includes(value))
        throw new RpcError(RPC_ERRORS.invalidParams, m.invalidValue(id, value));
      await this.change(id, { type: "set_thinking_level", level: value });
      await this.syncState();
      return this.configOptions();
    }
    throw new RpcError(RPC_ERRORS.invalidParams, m.unknownOption(id));
  }

  private async change(id: string, command: Json): Promise<void> {
    try {
      await this.request(command);
    } catch (error) {
      throw new RpcError(
        RPC_ERRORS.invalidParams,
        msg().bridge.config.setFailed(id, (error as Error).message),
      );
    }
  }

  /** 改动之后以 `get_state` 为准（Pi 可能把推理强度夹到模型支持的范围）。 */
  private async syncState(): Promise<void> {
    try {
      const state = dataOf(await this.request({ type: "get_state" }));
      const current = modelRefOf(state["model"]);
      this.configState = {
        ...this.configState,
        ...(current !== undefined ? { current } : {}),
        ...(typeof state["thinkingLevel"] === "string" ? { level: state["thinkingLevel"] } : {}),
      };
    } catch {
      // 以本地记录为准
    }
  }

  /** `session/load`：把已有消息回放成更新。 */
  async replay(): Promise<void> {
    const data = dataOf(await this.request({ type: "get_messages" }));
    const messages = Array.isArray(data["messages"]) ? (data["messages"] as Json[]) : [];
    for (const update of replayUpdates(messages, this.init.cwd, this.init.mcpServers))
      this.init.emit(update);
  }

  /** `usage_update`：上下文占用与窗口、累计费用（USD）；同值不重发，拿不到不发。 */
  async reportUsage(): Promise<void> {
    if (this.core.exited || this.closed || !this.init.info.capabilities.sessionStats) return;
    try {
      const stats = await Promise.race([
        this.request({ type: "get_session_stats" }),
        new Promise<Json>((resolve) => setTimeout(() => resolve({}), 5_000).unref()),
      ]);
      const data = dataOf(stats);
      const context = (data["contextUsage"] ?? {}) as Json;
      const size = context["contextWindow"];
      if (typeof size !== "number") return;
      const tokens = typeof context["tokens"] === "number" ? context["tokens"] : 0;
      const cost = data["cost"];
      const fromProvider = this.init.info.capabilities.costFromProvider
        ? this.mapper.costIsFromProvider()
        : undefined;
      const update: AcpSessionUpdate = {
        sessionUpdate: "usage_update",
        used: Math.max(0, Math.round(tokens)),
        size: Math.max(0, Math.round(size)),
        ...(typeof cost === "number" ? { cost: { amount: cost, currency: "USD" } } : {}),
        ...(fromProvider !== undefined ? { _meta: { "armadra.pi": { fromProvider } } } : {}),
      };
      const key = JSON.stringify(update);
      if (key === this.lastUsage) return;
      this.lastUsage = key;
      this.init.emit(update);
    } catch {
      // 统计拿不到不影响会话
    }
  }

  async prompt(blocks: unknown): Promise<AcpPromptResult> {
    if (this.closed || this.core.exited) throw this.exitedError();
    if (this.running !== undefined)
      throw new RpcError(RPC_ERRORS.invalidRequest, msg().bridge.session.busy);
    const command = promptCommand(blocks);
    this.mapper.resetTurn();
    this.interrupted = false;
    this.running = this.run(command);
    try {
      return await this.running;
    } catch (error) {
      throw asRpcError(error);
    } finally {
      this.running = undefined;
      this.settle = undefined;
      this.exitWaiters.clear();
    }
  }

  private async run(command: Json): Promise<AcpPromptResult> {
    // 先让出一拍：`this.running` 赋值之后再写命令（同步回显的对端里事件可能立刻到达并触发 cancel）
    await Promise.resolve();
    const settled = new Promise<boolean>((resolve) => (this.settle = resolve));
    const response = await this.core.request(command);
    if (response["success"] !== true)
      throw new RpcError(
        RPC_ERRORS.internalError,
        msg().bridge.pi.promptRejected(oneLine(String(response["error"] ?? "unknown"), 300)),
      );
    const handled =
      this.init.info.capabilities.disposition && dataOf(response)["disposition"] === "handled";
    let aborted = false;
    if (!handled) aborted = await Promise.race([settled, this.exitPromise()]);
    await this.reportUsage();
    return this.complete(aborted);
  }

  private complete(aborted: boolean): AcpPromptResult {
    const usage = this.mapper.turnUsage();
    const result = (stopReason: AcpPromptResult["stopReason"]): AcpPromptResult => ({
      stopReason,
      ...(usage !== undefined ? { usage } : {}),
    });
    if (aborted || this.interrupted) return result("cancelled");
    const last = this.mapper.lastAssistant();
    switch (last?.["stopReason"]) {
      case "error":
        throw new RpcError(
          RPC_ERRORS.internalError,
          msg().bridge.pi.turnFailed(oneLine(String(last["errorMessage"] ?? "unknown error"), 300)),
        );
      case "aborted":
        return result("cancelled");
      case "length":
        return result("max_tokens");
      default:
        return result("end_turn");
    }
  }

  /** `session/cancel`：撤回挂起的审批、发 `abort`，看门狗兜底。 */
  cancel(): void {
    const running = this.running;
    if (running === undefined || this.closed) return;
    this.interrupted = true;
    this.cancelPending();
    void this.core.request({ type: "abort" }).catch(() => undefined);
    armCancelWatchdog(
      this.init.transport,
      running.catch(() => undefined),
      {
        ...this.init.deps,
        log: (_level, message) => this.init.log(message),
      },
    );
  }

  /** 撤回挂起的审批（客户端收到 `$/cancel_request`）；Pi 一侧按拒绝应答。 */
  private cancelPending(): void {
    for (const controller of this.asks) controller.abort();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelPending();
    if (this.running !== undefined) {
      this.interrupted = true;
      this.core.write({ type: "abort" });
    }
    try {
      await this.init.transport.terminate();
    } finally {
      this.init.dispose();
    }
  }

  private exitedError(): RpcError {
    return new RpcError(
      RPC_ERRORS.internalError,
      msg().bridge.pi.exited(stderrHint(this.init.transport)),
      { code: "agent_exited" },
    );
  }

  private exitPromise(): Promise<never> {
    return new Promise<never>((_, reject) => {
      if (this.core.exited) reject(this.core.exitError());
      else this.exitWaiters.add(reject);
    });
  }

  private onExit(error: Error): void {
    for (const reject of this.exitWaiters) reject(error);
    this.exitWaiters.clear();
    this.cancelPending();
  }

  private onRecord(record: Json): void {
    if (record["type"] === "agent_settled") this.settle?.(record["aborted"] === true);
    else this.mapper.onEvent(record);
  }

  /** 当前模式与可选模式（`session/new|load|resume` 的 `modes`）。 */
  modes(): AcpSessionModeState {
    const desc = msg().bridge.modes;
    return {
      currentModeId: this.mode,
      availableModes: BRIDGE_MODES.map((id) => ({
        id,
        name: permissionModeLabel(id),
        description: desc[id],
      })),
    };
  }

  /** `session/set_mode`：立即生效（闸每次调用都问桥）。 */
  setMode(id: string): void {
    if (!isBridgeMode(id))
      throw new RpcError(RPC_ERRORS.invalidParams, msg().bridge.session.unknownMode(id));
    this.mode = id;
    this.init.emit({ sessionUpdate: "current_mode_update", currentModeId: id });
  }

  /** 扩展报告的能力：Pi 里有没有 `todo` / `subagent` / `questionnaire` 工具；没收到报告为 undefined。 */
  capabilities(): { todo: boolean; subagent: boolean; questionnaire: boolean } | undefined {
    const tools = this.tools;
    if (tools === undefined) return undefined;
    return {
      todo: tools.includes("todo"),
      subagent: tools.includes("subagent"),
      questionnaire: tools.includes("questionnaire"),
    };
  }

  /** 扩展 UI 请求：审批闸与拒绝理由、能力报告；其它对话框本批取消（后续批次接上征询）。 */
  private onUiRequest(record: Json): void {
    const id = String(record["id"] ?? "");
    const method = String(record["method"] ?? "");
    const respond = (body: Json): void =>
      this.core.write({ type: "extension_ui_response", id, ...body });
    if (method === "confirm" && record["title"] === PI_GATE_TITLE) {
      void this.onGate(record).then(
        (confirmed) => respond({ confirmed }),
        () => respond({ confirmed: false }),
      );
    } else if (method === "editor" && record["title"] === PI_REASON_TITLE) {
      const key = String(record["prefill"] ?? "");
      const reason = this.denials.get(key);
      this.denials.delete(key);
      respond(reason !== undefined ? { value: reason } : { cancelled: true });
    } else if (method === "setStatus" && record["statusKey"] === PI_STATUS_KEY) {
      this.onStatus(record["statusText"]);
    } else if (method === "notify") {
      if (record["notifyType"] === "warning" || record["notifyType"] === "error")
        this.init.log(oneLine(String(record["message"] ?? ""), 200));
    } else if (
      method === "select" ||
      method === "confirm" ||
      method === "input" ||
      method === "editor"
    ) {
      respond({ cancelled: true });
    }
  }

  private onStatus(text: unknown): void {
    try {
      const status = JSON.parse(String(text ?? "")) as Json;
      if (Array.isArray(status["tools"]))
        this.tools = status["tools"].filter((t): t is string => typeof t === "string");
      if (Array.isArray(status["mcpFailures"]))
        for (const failure of status["mcpFailures"])
          this.init.log(msg().bridge.pi.mcpFailed(oneLine(String(failure), 200)));
    } catch {
      // 不是我们的报告
    }
    this.resolveStatus?.();
  }

  /** 审批闸：按模式放行、拒绝，或把请求交给客户端（人）。返回是否放行。 */
  private async onGate(record: Json): Promise<boolean> {
    const call = parseGateCall(record["message"]);
    if (call === undefined || this.closed) return false;
    const verdict = verdictFor(this.mode, call);
    if (verdict.kind === "deny") {
      this.denials.set(call.id, verdict.reason);
      return false;
    }
    if (verdict.kind === "ask" && !(await this.askHuman(call))) return false;
    this.mapper.markRunning(call.id);
    return true;
  }

  /** `session/request_permission`（allow_once / reject_once）；客户端取消、出错或会话取消都按拒绝。 */
  private async askHuman(call: GateCall): Promise<boolean> {
    if (this.interrupted) return false;
    const controller = new AbortController();
    this.asks.add(controller);
    const core = msg().acp.core;
    try {
      const fields = this.mapper.describe(call.tool, call.input, {
        ...(call.parent !== undefined ? { parentToolCallId: call.parent } : {}),
      });
      const answer = await this.init.askPermission(
        {
          sessionId: this.id,
          toolCall: { toolCallId: call.id, status: "pending", ...fields },
          options: [
            { optionId: "allow_once", name: core.allowOnce, kind: "allow_once" },
            { optionId: "reject_once", name: core.rejectOnce, kind: "reject_once" },
          ],
        },
        controller.signal,
      );
      return (
        !controller.signal.aborted &&
        answer.outcome.outcome === "selected" &&
        answer.outcome.optionId === "allow_once"
      );
    } catch {
      return false;
    } finally {
      this.asks.delete(controller);
    }
  }
}
