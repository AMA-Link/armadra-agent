/**
 * Pi 事件 → ACP `session/update`（#254）。
 *
 * - `message_update` 的 text / thinking delta → `agent_message_chunk` / `agent_thought_chunk`；
 * - `tool_execution_start|update|end` → `tool_call` / `tool_call_update`（标题、类别、位置沿用驱动的规则；
 *   `partialResult` 与 `result` 转成内容；`rawInput` 带参数）。审批闸在 `tool_execution_start` 之后才问，
 *   所以要过闸的调用先以 `pending` 公布（权限请求关联到它），放行后 `markRunning` 转 `in_progress`；只读内置工具直接 `in_progress`；
 * - MCP 工具（`mcp__<server>__<tool>`，只认桥注册过的服务器）写 `_meta.is_mcp_tool_call` 与
 *   `rawInput {server, tool, arguments}`，客户端据此识别自家工具；codemode 里发起的内层调用带
 *   `_meta.ama.parentToolCallId`；
 * - 结果的 `details.todos` → `plan`（整表）；子 Agent 工具（`subagent`）写 `_meta["armadra.subagent"]`；
 * - assistant 的 `message_end` 累加本回合用量（input 不含缓存命中）与费用来源。
 */

import {
  ACP_META_KEY,
  type AcpPromptUsage,
  type AcpSessionUpdate,
  type AcpToolCall,
  type AcpToolCallStatus,
} from "../../drivers/acp/types.js";
import { PI_READ_ONLY_TOOLS } from "../../drivers/native/pi-extension.js";
import {
  bridgeToolTitle,
  mcpToolOf,
  piResultContent,
  piToolKind,
  piToolLocations,
  planEntriesOf,
  SUBAGENT_TOOL,
  subagentMeta,
  type Json,
  type McpToolRef,
} from "./tools.js";

export interface EventsOptions {
  cwd: string;
  emit(update: AcpSessionUpdate): void;
  /** 桥注册给 Pi 的 MCP 服务器名（客户端给的原样）。 */
  mcpServers(): readonly string[];
}

/** 一个回合累加的用量。 */
interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  seen: boolean;
}

const emptyUsage = (): TurnUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  seen: false,
});

export class PiEventMapper {
  /** 已公布的工具调用（id → 展示字段），供审批关联与结束时补全。 */
  private readonly published = new Map<string, { title: string; kind: AcpToolCall["kind"] }>();
  private usage: TurnUsage = emptyUsage();
  /** 本会话里 assistant 消息的费用是否都是账单值（`cost.totalFromProvider`）。 */
  private costMessages = 0;
  private costFromProvider = 0;
  private last: Json | undefined;

  constructor(private readonly options: EventsOptions) {}

  /** 回合开始：清空本回合用量。 */
  resetTurn(): void {
    this.usage = emptyUsage();
    this.last = undefined;
  }

  /** 本回合最后一条 assistant 消息（判停止原因、取最终文本）。 */
  lastAssistant(): Json | undefined {
    return this.last;
  }

  /** 本回合累加的用量（没收到任何 assistant 消息返回 undefined）。 */
  turnUsage(): AcpPromptUsage | undefined {
    const u = this.usage;
    if (!u.seen) return undefined;
    return {
      inputTokens: u.input,
      outputTokens: u.output,
      cachedReadTokens: u.cacheRead,
      cachedWriteTokens: u.cacheWrite,
      totalTokens: u.total > 0 ? u.total : u.input + u.output + u.cacheRead + u.cacheWrite,
    };
  }

  /** 费用是否全是账单值：没见过任何带费用的 assistant 消息时 undefined。 */
  costIsFromProvider(): boolean | undefined {
    return this.costMessages === 0 ? undefined : this.costFromProvider === this.costMessages;
  }

  /** 已公布调用的标题与类别。 */
  toolInfo(id: string): { title: string; kind: AcpToolCall["kind"] } | undefined {
    return this.published.get(id);
  }

  /** 审批闸放行：调用从 `pending` 转为 `in_progress`。 */
  markRunning(id: string): void {
    if (this.published.has(id))
      this.options.emit({
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "in_progress",
      });
  }

  onEvent(record: Json): void {
    switch (record["type"]) {
      case "message_update":
        this.onMessageUpdate(record);
        return;
      case "message_end":
        this.onMessageEnd(record);
        return;
      case "tool_execution_start":
        this.onToolStart(record);
        return;
      case "tool_execution_update":
        this.onToolUpdate(record);
        return;
      case "tool_execution_end":
        this.onToolEnd(record);
        return;
      default:
    }
  }

  private onMessageUpdate(record: Json): void {
    const event = (record["assistantMessageEvent"] ?? {}) as Json;
    const delta = event["delta"];
    if (typeof delta !== "string" || delta === "") return;
    if (event["type"] === "text_delta")
      this.options.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: delta },
      });
    else if (event["type"] === "thinking_delta")
      this.options.emit({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: delta },
      });
  }

  private onMessageEnd(record: Json): void {
    const message = (record["message"] ?? {}) as Json;
    if (message["role"] !== "assistant") return;
    this.last = message;
    const usage = (message["usage"] ?? {}) as Json;
    const num = (key: string): number =>
      typeof usage[key] === "number" ? (usage[key] as number) : 0;
    const u = this.usage;
    this.usage = {
      input: u.input + num("input"),
      output: u.output + num("output"),
      cacheRead: u.cacheRead + num("cacheRead"),
      cacheWrite: u.cacheWrite + num("cacheWrite"),
      total: u.total + num("totalTokens"),
      seen: true,
    };
    const cost = (usage["cost"] ?? {}) as Json;
    if (typeof cost["total"] === "number") {
      this.costMessages++;
      const billed = cost["totalFromProvider"];
      if (billed === true || typeof billed === "number") this.costFromProvider++;
    }
  }

  private mcpRef(tool: string): McpToolRef | undefined {
    return mcpToolOf(tool, this.options.mcpServers());
  }

  /** 一次调用的展示字段（`tool_call` 与权限请求的 `toolCall` 共用）。 */
  describe(
    tool: string,
    input: Json,
    record?: Json,
  ): Omit<AcpToolCall, "toolCallId" | "status"> & { title: string } {
    const mcp = this.mcpRef(tool);
    const locations = piToolLocations(input, this.options.cwd);
    const meta = this.metaOf(record, mcp, tool, input);
    return {
      title: bridgeToolTitle(tool, input, mcp),
      kind: piToolKind(tool),
      name: tool,
      rawInput:
        mcp !== undefined ? { server: mcp.server, tool: mcp.tool, arguments: input } : input,
      ...(locations !== undefined ? { locations } : {}),
      ...(meta !== undefined ? { _meta: meta } : {}),
    };
  }

  /** 公布一个新调用（`tool_call`）。 */
  private publish(
    id: string,
    tool: string,
    input: Json,
    status: AcpToolCallStatus,
    record: Json | undefined,
    extra: Partial<AcpToolCall> = {},
  ): void {
    const fields = this.describe(tool, input, record);
    this.published.set(id, { title: fields.title, kind: fields.kind });
    this.options.emit({ sessionUpdate: "tool_call", toolCallId: id, status, ...fields, ...extra });
  }

  /** `_meta`：自家工具标记（顶层，客户端约定）与 ama 命名空间下的父调用。 */
  private metaOf(
    record: Json | undefined,
    mcp: McpToolRef | undefined,
    tool: string,
    input: Json,
  ): Json | undefined {
    const meta: Json = {};
    if (mcp !== undefined) meta["is_mcp_tool_call"] = true;
    if (tool === SUBAGENT_TOOL) {
      const sub = subagentMeta(input);
      if (sub !== undefined) meta["armadra.subagent"] = sub;
    }
    const parent = record?.["parentToolCallId"];
    if (typeof parent === "string" && parent !== "")
      meta[ACP_META_KEY] = { parentToolCallId: parent };
    return Object.keys(meta).length > 0 ? meta : undefined;
  }

  private onToolStart(record: Json): void {
    const id = String(record["toolCallId"] ?? "");
    const tool = String(record["toolName"] ?? "tool");
    const input = (record["args"] ?? {}) as Json;
    // 审批闸在 `tool_execution_start` 之后才问：要过闸的调用先标 `pending`，放行后再转 `in_progress`
    if (!this.published.has(id)) {
      const gated = !PI_READ_ONLY_TOOLS.includes(tool);
      this.publish(id, tool, input, gated ? "pending" : "in_progress", record);
    }
  }

  private onToolUpdate(record: Json): void {
    const id = String(record["toolCallId"] ?? "");
    if (!this.published.has(id))
      this.publish(
        id,
        String(record["toolName"] ?? "tool"),
        (record["args"] ?? {}) as Json,
        "in_progress",
        record,
      );
    const content = piResultContent(record["partialResult"]);
    if (content !== undefined)
      this.options.emit({
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "in_progress",
        content,
      });
  }

  private onToolEnd(record: Json): void {
    const id = String(record["toolCallId"] ?? "");
    const status: AcpToolCallStatus = record["isError"] === true ? "failed" : "completed";
    // todo 类工具把整表放在结果的 details.todos：每来一次结果就整表发一次 plan
    const entries =
      record["isError"] === true
        ? undefined
        : planEntriesOf(((record["result"] ?? {}) as Json)["details"]);
    if (entries !== undefined) this.options.emit({ sessionUpdate: "plan", entries });
    const content = piResultContent(record["result"]);
    if (!this.published.has(id)) {
      // 没执行就结束的调用（被阻止、参数不合）：直接公布成终态
      this.publish(
        id,
        String(record["toolName"] ?? "tool"),
        (record["args"] ?? {}) as Json,
        status,
        record,
        {
          ...(content !== undefined ? { content } : {}),
        },
      );
      this.published.delete(id);
      return;
    }
    this.published.delete(id);
    this.options.emit({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      status,
      ...(content !== undefined ? { content } : {}),
    });
  }
}
