/**
 * 权限类 `network`（`web_fetch` 用；docs/guides/permissions.md「网络类」）。照 `memory-class.ts` 的写法
 * 折成已有的类走真值表：
 *
 * - 按 `execute` 判：default / auto-edit 询问（审批第三项「本会话允许该主机」）、allowlist 只放行 allow 规则
 *   命中的、full-auto 放行、auto 交分类器；
 * - plan 例外：**询问**（只读但可外泄；plan 的调研常要看文档），无人值守照常 ask → deny；
 * - auto 规则层：URL 静态校验不过（非 http(s)、userinfo、本机名、私网 / 元数据 IP 字面量）直接 deny；
 *   解析后的地址检查在执行层（url-guard.ts），这里不查 DNS。
 *
 * 规则 `web_fetch(<pattern>)` 对 `host/path`（不含协议、端口与查询串，主机名小写）匹配：
 * - 不含 `/` 的 pattern 只比主机：裸域名 `example.com` 命中它自己与全部子域；带 `*` 时按 glob
 *   （`*.example.com`），任意路径；
 * - 含 `/` 的 pattern 对整个 `host/path` 做 glob：`*` 不跨 `/`，`**` 跨（`docs.example.com/api/**`）。
 */

import type { ToolPermission } from "../tools/types.js";
import { bareHostname, checkFetchUrl } from "../tools/web/url-guard.js";

/** `network` 类在真值表里按哪一类判定（plan 例外由管线处理）。 */
export function networkEffectivePermission(): Exclude<ToolPermission, "memory" | "network"> {
  return "execute";
}

/** 输入里的 URL（`url` 字段，能解析的 http(s)）；没有返回 undefined。 */
export function inputUrl(input: unknown): URL | undefined {
  const raw =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)["url"]
      : undefined;
  if (typeof raw !== "string") return undefined;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** 规则匹配的对象：`host/path`（主机名小写、无端口与查询串）。 */
export function urlSubject(url: URL): string {
  return `${bareHostname(url)}${url.pathname === "" ? "/" : url.pathname}`;
}

function globRegExp(pattern: string): RegExp {
  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "*" && pattern[i + 1] === "*") {
      body += ".*";
      i++;
    } else if (ch === "*") body += "[^/]*";
    else if (ch === "?") body += "[^/]";
    else body += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${body}$`, "i");
}

/** `web_fetch(<pattern>)` 是否命中这次调用。 */
export function networkRuleMatches(pattern: string, input: unknown): boolean {
  const url = inputUrl(input);
  if (url === undefined) return false;
  const p = pattern
    .trim()
    .replace(/^https?:\/\//i, "")
    .toLowerCase();
  if (p === "*" || p === "**") return true;
  const host = bareHostname(url);
  if (!p.includes("/")) {
    if (p.includes("*") || p.includes("?")) return globRegExp(p).test(host);
    const bare = p.replace(/\.$/, "");
    return host === bare || host.endsWith(`.${bare}`);
  }
  return globRegExp(p).test(urlSubject(url));
}

/** 会话记忆「本会话允许该主机」的归一化前缀：小写主机名。 */
export function networkGrantHost(input: unknown): string | undefined {
  const url = inputUrl(input);
  return url === undefined ? undefined : bareHostname(url);
}

/** auto 规则层：URL 静态校验不过时的拒绝原因（不查 DNS）。 */
export function networkBlockReason(input: unknown): string | undefined {
  const raw =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)["url"]
      : undefined;
  if (typeof raw !== "string") return "url is missing";
  const checked = checkFetchUrl(raw);
  return checked.ok ? undefined : checked.reason;
}
