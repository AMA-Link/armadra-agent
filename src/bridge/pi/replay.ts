/**
 * `session/load` 的回放（#254）：Pi 的 `get_messages` → ACP 更新。
 *
 * user → `user_message_chunk`；assistant 的 text / thinking → `agent_message_chunk` / `agent_thought_chunk`，
 * toolCall → 终态的 `tool_call`（结果来自随后的 `toolResult` 消息）；最后一次带 `details.todos` 的结果补一份 `plan`。
 * system 与未知角色跳过。
 */

import type { AcpPlanEntry, AcpSessionUpdate, AcpToolCallStatus } from "../../drivers/acp/types.js";
import {
  bridgeToolTitle,
  mcpToolOf,
  piResultContent,
  piToolKind,
  piToolLocations,
  planEntriesOf,
  type Json,
} from "./tools.js";

export function replayUpdates(
  messages: readonly Json[],
  cwd: string,
  mcpServers: readonly string[],
): AcpSessionUpdate[] {
  const results = new Map<string, Json>();
  for (const message of messages)
    if (message["role"] === "toolResult" && typeof message["toolCallId"] === "string")
      results.set(message["toolCallId"], message);
  const out: AcpSessionUpdate[] = [];
  let plan: AcpPlanEntry[] | undefined;
  for (const message of messages) {
    if (message["role"] === "toolResult") plan = planEntriesOf(message["details"]) ?? plan;
    const content = message["content"];
    const blocks: Json[] =
      typeof content === "string"
        ? [{ type: "text", text: content }]
        : Array.isArray(content)
          ? (content as Json[])
          : [];
    if (message["role"] === "user") {
      for (const block of blocks) {
        if (block["type"] === "text" && typeof block["text"] === "string" && block["text"] !== "")
          out.push({
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: block["text"] },
          });
        else if (
          block["type"] === "image" &&
          typeof block["data"] === "string" &&
          typeof block["mimeType"] === "string"
        )
          out.push({
            sessionUpdate: "user_message_chunk",
            content: { type: "image", data: block["data"], mimeType: block["mimeType"] },
          });
      }
    } else if (message["role"] === "assistant") {
      for (const block of blocks) {
        if (block["type"] === "text" && typeof block["text"] === "string" && block["text"] !== "")
          out.push({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: block["text"] },
          });
        else if (
          block["type"] === "thinking" &&
          typeof block["thinking"] === "string" &&
          block["thinking"] !== ""
        )
          out.push({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: block["thinking"] },
          });
        else if (block["type"] === "toolCall" && typeof block["id"] === "string") {
          const tool = String(block["name"] ?? "tool");
          const input = (block["arguments"] ?? {}) as Json;
          const mcp = mcpToolOf(tool, mcpServers);
          const result = results.get(block["id"]);
          const status: AcpToolCallStatus =
            result === undefined
              ? "completed"
              : result["isError"] === true
                ? "failed"
                : "completed";
          const resultContent = result !== undefined ? piResultContent(result) : undefined;
          const locations = piToolLocations(input, cwd);
          out.push({
            sessionUpdate: "tool_call",
            toolCallId: block["id"],
            title: bridgeToolTitle(tool, input, mcp),
            kind: piToolKind(tool),
            status,
            name: tool,
            rawInput:
              mcp !== undefined ? { server: mcp.server, tool: mcp.tool, arguments: input } : input,
            ...(locations !== undefined ? { locations } : {}),
            ...(resultContent !== undefined ? { content: resultContent } : {}),
            ...(mcp !== undefined ? { _meta: { is_mcp_tool_call: true } } : {}),
          });
        }
      }
    }
  }
  // 回放末尾补一份当前计划（最后一次带 todos 的结果）
  if (plan !== undefined) out.push({ sessionUpdate: "plan", entries: plan });
  return out;
}
