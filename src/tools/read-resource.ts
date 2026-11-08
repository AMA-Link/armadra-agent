/**
 * `read` 工具的宿主资源分支（#270）：路径是已注册的 `scheme://path` 时交给宿主读，照 `read` 的口径
 * 编号、分页与截断，首行标注不可信（与 `web_fetch` 同一套）。
 *
 * - 先校验 `offset` / `limit`（与文件分支相同），再调宿主 `read(path, { offset, limit, signal })`；
 *   `signal` 合并会话中断与 `HOST_RESOURCE_TIMEOUT_MS` 超时。
 * - 宿主抛错 / 超时 / 返回形状不对 / 返回 undefined 都是 `isError` 的工具结果，不抛到会话。
 * - `text` 只收文本（含 NUL 按二进制拒绝），按宿主的 `limit` 再切一刀（宿主多给的行丢弃），`cat -n`
 *   编号后 `truncateHead`（2000 行 / 会话字节上限），续读提示 `Use offset=N`。
 * - 未注册的 scheme 回错误并列出已注册的；`http(s)://` 另提示用 `web_fetch`。
 */

import type { ToolContext, ToolResult } from "./types.js";
import { numberLines } from "./read-lines.js";
import { DEFAULT_MAX_LINES, formatSize, toolOutputBytes, truncateHead } from "./truncate.js";
import {
  HOST_RESOURCE_TIMEOUT_MS,
  type HostResourceContent,
  type HostResourceLookup,
  type ResourceRef,
} from "./resource-ref.js";

const ERROR_MESSAGE_CHARS = 200;

function error(message: string): ToolResult {
  return { content: message, isError: true };
}

function errorText(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
  return text.length > ERROR_MESSAGE_CHARS ? `${text.slice(0, ERROR_MESSAGE_CHARS - 1)}…` : text;
}

/** 未注册 scheme 的错误：列出已注册的；URL 指向 web_fetch。 */
export function unknownSchemeMessage(ref: ResourceRef, schemes: readonly string[]): string {
  const listed = schemes.map((s) => `${s}://`).join(", ");
  const hint =
    ref.scheme === "http" || ref.scheme === "https" ? "; use web_fetch for http(s) URLs" : "";
  return `Unknown resource scheme "${ref.scheme}://"${hint}; registered: ${listed}`;
}

function isContent(value: unknown): value is HostResourceContent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record["text"] !== "string") return false;
  for (const key of ["next", "total"]) {
    const n = record[key];
    if (n !== undefined && (!Number.isInteger(n) || (n as number) < 0)) return false;
  }
  return true;
}

export interface ResourceReadOptions {
  timeoutMs?: number;
}

/** `read` 输入里与资源有关的部分（path 已解析成 ref）。 */
export interface ResourceReadInput {
  offset?: number;
  limit?: number;
}

export async function executeResourceRead(
  ref: ResourceRef,
  input: ResourceReadInput,
  ctx: ToolContext,
  lookup: HostResourceLookup,
  options: ResourceReadOptions = {},
): Promise<ToolResult> {
  const resource = lookup.get(ref.scheme);
  if (resource === undefined) return error(unknownSchemeMessage(ref, lookup.schemes()));
  const offset = input.offset ?? 1;
  if (!Number.isInteger(offset) || offset < 1) return error("offset must be an integer ≥ 1");
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
    return error("limit must be an integer ≥ 1");
  }
  const timeoutMs = options.timeoutMs ?? HOST_RESOURCE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const signal = AbortSignal.any([ctx.signal, controller.signal]);
  let content: unknown;
  try {
    content = await new Promise<unknown>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      Promise.resolve()
        .then(() =>
          resource.read(ref.path, {
            offset,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            signal,
          }),
        )
        .then(resolve, reject);
    });
  } catch (err) {
    const reason = controller.signal.aborted
      ? `the host did not answer within ${timeoutMs / 1000}s`
      : ctx.signal.aborted
        ? "aborted"
        : errorText(err);
    return error(`Cannot read ${ref.raw}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  if (content === undefined || content === null) return error(`Resource not found: ${ref.raw}`);
  if (!isContent(content))
    return error(`Cannot read ${ref.raw}: the host returned an invalid result`);
  if (content.text.includes("\0")) {
    return error(`${ref.raw} appears to be binary content; refusing to read it`);
  }
  const normalized = content.text.replace(/\r\n?/g, "\n");
  let lines = normalized === "" ? [] : normalized.replace(/\n$/, "").split("\n");
  let next = content.next;
  if (input.limit !== undefined && lines.length > input.limit) {
    lines = lines.slice(0, input.limit);
    next = offset + input.limit;
  }
  const details = {
    resource: ref.raw,
    scheme: ref.scheme,
    firstLine: offset,
    lastLine: offset - 1 + lines.length,
    ...(content.total !== undefined ? { total: content.total } : {}),
    truncated: false,
  };
  if (lines.length === 0) {
    if (offset > 1) {
      const total = content.total !== undefined ? ` (${content.total} lines)` : "";
      return error(`offset ${offset} is beyond the end of ${ref.raw}${total}`);
    }
    return { content: `(${ref.raw} is empty)`, details };
  }
  const maxBytes = toolOutputBytes(ctx.maxResultChars);
  const cut = truncateHead(numberLines(lines, offset), { maxLines: DEFAULT_MAX_LINES, maxBytes });
  const lastShown = offset - 1 + cut.outputLines;
  let body = cut.content;
  const more = cut.truncated || (next !== undefined && next > lastShown);
  if (more) {
    const of = content.total !== undefined ? ` of ${content.total}` : "";
    const reason = cut.truncated
      ? ` (output limit ${cut.truncatedBy === "bytes" ? formatSize(maxBytes) : `${DEFAULT_MAX_LINES} lines`} reached)`
      : "";
    body += `\n\n[Showing lines ${offset}-${lastShown}${of}${reason}. Use offset=${lastShown + 1} to continue.]`;
  }
  return {
    content: `Content read from ${ref.raw} (untrusted):\n\n${body}`,
    details: { ...details, lastLine: lastShown, truncated: cut.truncated },
  };
}
