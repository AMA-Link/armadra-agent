/**
 * 客户端 `mcpServers`（ACP 形状）→ Pi 的 `registerMcpServer` 配置（#254）。
 *
 * ama 自己不说 MCP：这里只做形状转换，连接由 Pi 内置的 MCP 完成（扩展加载时对每一项调用
 * `pi.registerMcpServer(name, { …, exposure: "direct" })`）。stdio 与 http 支持；sse 桥没有声明
 * （`mcpCapabilities.sse: false`），收到也跳过。Pi 的服务器名只允许字母、数字、`_`、`-`，其余换成 `_`。
 */

import type { Json } from "./tools.js";

export interface PiMcpPlan {
  /** 写进 `bridge.json` 的 `mcpServers`（Pi 的服务器名 → 配置）。 */
  servers: Record<string, Json>;
  /** 客户端给的原名（桥用它认 `mcp__<server>__<tool>`）。 */
  names: string[];
  /** 被跳过的条目（名字或 `#序号`），调用方写一行 stderr。 */
  skipped: string[];
}

function pairs(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(value)) return out;
  for (const item of value as Json[]) {
    const name = item["name"];
    const val = item["value"];
    if (typeof name === "string" && name !== "" && typeof val === "string") out[name] = val;
  }
  return out;
}

export function piMcpPlan(list: unknown): PiMcpPlan {
  const plan: PiMcpPlan = { servers: {}, names: [], skipped: [] };
  if (!Array.isArray(list)) return plan;
  list.forEach((entry, index) => {
    const server = (entry ?? {}) as Json;
    const name = server["name"];
    if (typeof name !== "string" || name === "") {
      plan.skipped.push(`#${index + 1}`);
      return;
    }
    const piName = name.replace(/[^A-Za-z0-9_-]/g, "_");
    const type = server["type"];
    if (typeof server["command"] === "string" && (type === undefined || type === "stdio")) {
      const args = Array.isArray(server["args"])
        ? (server["args"] as unknown[]).filter((a): a is string => typeof a === "string")
        : [];
      plan.servers[piName] = { command: server["command"], args, env: pairs(server["env"]) };
    } else if (type === "http" && typeof server["url"] === "string") {
      plan.servers[piName] = { url: server["url"], headers: pairs(server["headers"]) };
    } else {
      plan.skipped.push(name);
      return;
    }
    plan.names.push(name);
  });
  return plan;
}
