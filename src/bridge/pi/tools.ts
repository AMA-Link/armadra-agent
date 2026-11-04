/**
 * Pi 工具调用 → ACP 工具调用的展示字段（#254）：标题、类别、位置、结果内容，以及 MCP 工具名的拆解。
 *
 * Pi 把 MCP 工具注册成 `mcp__<server>__<tool>`，名字里除字母、数字、`_` 以外的字符都换成 `_`；拆回原服务器名时
 * 只对桥自己注册过的服务器匹配（取最长的），认不出的当普通工具。
 */

import { isAbsolute, resolve } from "node:path";
import type { AcpToolCallContent, AcpToolCallLocation } from "../../drivers/acp/types.js";
import { piToolTitle } from "../../drivers/native/pi-rpc.js";
import { msg } from "../../i18n/index.js";
import { TOOL_OUTPUT_LIMIT } from "../../modes/acp/acp-tool-text.js";

import type { Json } from "../../drivers/native/pi-rpc-core.js";

export type { Json };
export { piToolKind } from "../../drivers/native/pi-rpc.js";

/** Pi 对 MCP 工具名的规整：字母、数字、`_` 以外的字符换成 `_`。 */
export function piToolSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

export interface McpToolRef {
  /** 客户端给的服务器名（原样）。 */
  server: string;
  /** Pi 名字里 `mcp__<server>__` 之后的部分。 */
  tool: string;
}

/** 认出桥注册过的 MCP 工具；`servers` 是客户端给的服务器名。 */
export function mcpToolOf(name: string, servers: readonly string[]): McpToolRef | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  let best: McpToolRef | undefined;
  let bestLength = -1;
  for (const server of servers) {
    const prefix = `mcp__${piToolSegment(server)}__`;
    if (name.startsWith(prefix) && prefix.length > bestLength) {
      best = { server, tool: name.slice(prefix.length) };
      bestLength = prefix.length;
    }
  }
  return best;
}

function argOf(args: Json, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** 标题：MCP 工具写成 `<服务器>: <工具>`，其余沿用驱动的规则。 */
export function bridgeToolTitle(tool: string, input: Json, mcp?: McpToolRef): string {
  return mcp !== undefined ? `${mcp.server}: ${mcp.tool}` : piToolTitle(tool, input);
}

export function piToolLocations(input: Json, cwd: string): AcpToolCallLocation[] | undefined {
  const path = argOf(input, "path");
  if (path === undefined) return undefined;
  return [{ path: isAbsolute(path) ? path : resolve(cwd, path) }];
}

/** Pi 的 `{content: [...]}` 结果 → ACP 内容（文本前 4 KB，图片原样；没有内容返回 undefined）。 */
export function piResultContent(result: unknown): AcpToolCallContent[] | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const blocks = (result as Json)["content"];
  if (!Array.isArray(blocks)) return undefined;
  const out: AcpToolCallContent[] = [];
  let text = "";
  for (const block of blocks as Json[]) {
    if (block["type"] === "text" && typeof block["text"] === "string") text += block["text"];
    else if (
      block["type"] === "image" &&
      typeof block["data"] === "string" &&
      typeof block["mimeType"] === "string"
    )
      out.push({
        type: "content",
        content: { type: "image", data: block["data"], mimeType: block["mimeType"] },
      });
  }
  if (text !== "")
    out.unshift({
      type: "content",
      content: {
        type: "text",
        text:
          text.length > TOOL_OUTPUT_LIMIT
            ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n${msg().acp.tools.truncated(text.length)}`
            : text,
      },
    });
  return out.length > 0 ? out : undefined;
}
