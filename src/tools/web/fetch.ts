/**
 * `web_fetch` 工具（docs/guides/permissions.md「网络类」）：GET 一个公网 http(s) URL，HTML 转 Markdown，
 * JSON 美化，`text/*` 原样，二进制不解析。权限类 `network`（default 询问、`-p` 拒绝，见 network-class.ts）。
 *
 * - 地址：`url-guard.ts` 静态校验 + 解析后全部地址检查 + 连接时钉住已检查的地址；同主机重定向 ≤ 5 跳、
 *   逐跳重检；跨主机不跟，告诉模型目标 URL（下一次调用重新过权限）。
 * - 限制写死：总超时 30 s、首字节 15 s、响应体（解压后）≤ 5 MB；不发 cookie、无自定义头、只有 GET。
 *   `agent: false`：不复用连接、不走全局代理 agent（代理会自己解析主机名，钉不住地址）。
 * - 输出首行固定 `Content fetched from <final url> (untrusted):`；正文按 `offset` / `maxChars` 切片，
 *   截断时全文写 `outputs/<toolCallId>.txt` 并在末尾说明续读的 offset。
 * - 测试注入 `lookup` 与 `request`（不出网）。
 */

import * as http from "node:http";
import * as https from "node:https";
import type { IncomingMessage } from "node:http";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import { AMA_VERSION } from "../../version.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";
import { RESULT_NOTE_RESERVE, writeFullOutput } from "../truncate.js";
import { htmlToMarkdown, sniffMetaCharset } from "./html-to-markdown.js";
import {
  MAX_SAME_HOST_REDIRECTS,
  checkFetchUrl,
  pinnedLookup,
  redirectPolicy,
  resolvePublicAddresses,
  type LookupAll,
} from "./url-guard.js";

export const WEB_FETCH_TOOL = "web_fetch";
export const DEFAULT_FETCH_CHARS = 50_000;
export const MAX_FETCH_CHARS = 200_000;
export const FETCH_TOTAL_TIMEOUT_MS = 30_000;
export const FETCH_FIRST_BYTE_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BODY_BYTES = 5 * 1024 * 1024;
const ERROR_BODY_CHARS = 2_000;

/** 地址守卫、超时、重定向等自己产生的错误（说明直接进工具结果）。 */
class FetchError extends Error {}

export const FETCH_ACCEPT =
  "text/markdown, text/html, text/plain, application/json;q=0.9, */*;q=0.1";

export interface WebFetchInput {
  url: string;
  maxChars?: number;
  offset?: number;
  raw?: boolean;
}

export type FetchRequest = (
  url: URL,
  options: http.RequestOptions,
  onResponse: (res: IncomingMessage) => void,
) => http.ClientRequest;

export interface WebFetchOptions {
  lookup?: LookupAll;
  request?: FetchRequest;
  totalTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  maxBodyBytes?: number;
}

export type FetchFormat = "markdown" | "text" | "json" | "binary";

export interface WebFetchDetails {
  status: number;
  contentType: string;
  bytes: number;
  truncated: boolean;
  finalUrl: string;
  format?: FetchFormat;
  title?: string;
}

const defaultRequest: FetchRequest = (url, options, onResponse) =>
  (url.protocol === "https:" ? https : http).request(url, options, onResponse);

interface Fetched {
  res: IncomingMessage;
  finalUrl: string;
  body: Buffer;
  bodyCut: boolean;
}

function fail(content: string, details?: Partial<WebFetchDetails>): ToolResult {
  return { content, isError: true, ...(details !== undefined ? { details } : {}) };
}

/** 读响应体（按 Content-Encoding 解压），解压后超过上限即停。 */
function readBody(res: IncomingMessage, limit: number): Promise<{ body: Buffer; cut: boolean }> {
  const encoding = String(res.headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  let stream: Readable = res;
  if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(createGunzip());
  else if (encoding === "br") stream = res.pipe(createBrotliDecompress());
  else if (encoding === "deflate") stream = res.pipe(createInflate());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (cut: boolean) => {
      if (done) return;
      done = true;
      resolve({ body: Buffer.concat(chunks, Math.min(size, limit)).subarray(0, limit), cut });
    };
    stream.on("data", (chunk: Buffer) => {
      if (done) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        finish(true);
        res.destroy();
        if (stream !== res) stream.destroy();
      }
    });
    stream.on("end", () => finish(false));
    stream.on("error", (err) => (done ? undefined : ((done = true), reject(err))));
    res.on("error", (err) => (done ? undefined : ((done = true), reject(err))));
  });
}

function decodeText(body: Buffer, contentType: string, html: boolean): string {
  const declared = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1];
  const sniffed = html ? sniffMetaCharset(body.subarray(0, 2048).toString("latin1")) : undefined;
  for (const label of [declared, sniffed, "utf-8"]) {
    if (label === undefined) continue;
    try {
      return new TextDecoder(label).decode(body);
    } catch {
      // 不支持的编码：试下一个
    }
  }
  return body.toString("utf8");
}

function formatOf(contentType: string, body: Buffer): FetchFormat | "html" {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (
    type.startsWith("text/") ||
    /^application\/(xml|javascript|ecmascript|x-yaml|yaml|toml)$/.test(type) ||
    type.endsWith("+xml")
  )
    return "text";
  if (type === "") {
    const head = body.subarray(0, 1024);
    if (head.includes(0)) return "binary";
    return /^\s*<(!doctype html|html)/i.test(head.toString("latin1")) ? "html" : "text";
  }
  return "binary";
}

/** 按格式转成文本：`{ format, title, text }`。 */
function convert(
  body: Buffer,
  contentType: string,
  finalUrl: string,
  raw: boolean,
): { format: FetchFormat; title?: string; text: string } {
  const kind = formatOf(contentType, body);
  if (kind === "binary") {
    const type = contentType.split(";")[0]?.trim() || "unknown type";
    return {
      format: "binary",
      text: `Binary content (${type}, ${body.length} bytes); not parsed.`,
    };
  }
  const text = decodeText(body, contentType, kind === "html");
  if (raw) return { format: "text", text };
  if (kind === "html") {
    const page = htmlToMarkdown(text, finalUrl);
    return page.title === undefined
      ? { format: "markdown", text: page.markdown }
      : { format: "markdown", title: page.title, text: page.markdown };
  }
  if (kind === "json") {
    try {
      return { format: "json", text: JSON.stringify(JSON.parse(text), null, 2) };
    } catch {
      return { format: "text", text };
    }
  }
  return { format: "text", text };
}

export function createWebFetchTool(options: WebFetchOptions = {}): ToolDefinition<WebFetchInput> {
  const request = options.request ?? defaultRequest;
  const totalMs = options.totalTimeoutMs ?? FETCH_TOTAL_TIMEOUT_MS;
  const firstByteMs = options.firstByteTimeoutMs ?? FETCH_FIRST_BYTE_TIMEOUT_MS;
  const maxBody = options.maxBodyBytes ?? FETCH_MAX_BODY_BYTES;

  /** 一跳：解析 + 检查 + 钉住地址发 GET，等到响应头。 */
  async function get(url: URL, hostname: string, signal: AbortSignal): Promise<IncomingMessage> {
    const resolved = await resolvePublicAddresses(hostname, options.lookup);
    if (!resolved.ok) throw new FetchError(resolved.reason);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy(new FetchError(`no response within ${firstByteMs / 1000}s`));
      }, firstByteMs);
      const req = request(
        url,
        {
          method: "GET",
          agent: false,
          lookup: pinnedLookup(resolved.addresses) as unknown as http.RequestOptions["lookup"],
          headers: {
            Accept: FETCH_ACCEPT,
            "Accept-Encoding": "gzip, deflate, br",
            "User-Agent": `ama/${AMA_VERSION}`,
          },
          signal,
        },
        (res) => {
          clearTimeout(timer);
          resolve(res);
        },
      );
      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.end();
    });
  }

  async function fetchFollowing(
    start: URL,
    hostname: string,
    signal: AbortSignal,
  ): Promise<Fetched | { redirect: string; status: number }> {
    let url = start;
    let host = hostname;
    for (let hop = 0; ; hop++) {
      const res = await get(url, host, signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && typeof location === "string") {
        res.resume();
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new FetchError(`invalid redirect location ${JSON.stringify(location)}`);
        }
        if (redirectPolicy(url, next) === "cross-host") return { redirect: next.href, status };
        const checked = checkFetchUrl(next.href);
        if (!checked.ok)
          throw new FetchError(`redirect to ${next.href} refused: ${checked.reason}`);
        if (hop + 1 > MAX_SAME_HOST_REDIRECTS)
          throw new FetchError(`more than ${MAX_SAME_HOST_REDIRECTS} redirects`);
        url = checked.url;
        host = checked.hostname;
        continue;
      }
      const { body, cut } = await readBody(res, maxBody);
      return { res, finalUrl: url.href, body, bodyCut: cut };
    }
  }

  async function execute(input: WebFetchInput, ctx: ToolContext): Promise<ToolResult> {
    const checked = checkFetchUrl(input.url);
    if (!checked.ok) return fail(`Cannot fetch ${String(input.url)}: ${checked.reason}`);
    const offset = input.offset ?? 0;
    const asked = input.maxChars ?? DEFAULT_FETCH_CHARS;
    if (!Number.isInteger(offset) || offset < 0) return fail("offset must be an integer ≥ 0");
    if (!Number.isInteger(asked) || asked < 1) return fail("maxChars must be an integer ≥ 1");
    const sessionCap =
      ctx.maxResultChars === undefined ? Infinity : ctx.maxResultChars - RESULT_NOTE_RESERVE;
    const limit = Math.max(1000, Math.min(asked, MAX_FETCH_CHARS, sessionCap));

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new FetchError(`timed out after ${totalMs / 1000}s`)),
      totalMs,
    );
    const signal = AbortSignal.any([ctx.signal, controller.signal]);
    let fetched: Awaited<ReturnType<typeof fetchFollowing>>;
    try {
      fetched = await fetchFollowing(checked.url, checked.hostname, signal);
    } catch (err) {
      const reason =
        controller.signal.aborted && controller.signal.reason instanceof FetchError
          ? controller.signal.reason.message
          : err instanceof Error
            ? err.message
            : String(err);
      return fail(`Cannot fetch ${checked.url.href}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    if ("redirect" in fetched) {
      return {
        content: `Redirected to ${fetched.redirect}; call web_fetch with it if appropriate.`,
        details: {
          status: fetched.status,
          contentType: "",
          bytes: 0,
          truncated: false,
          finalUrl: fetched.redirect,
        } satisfies WebFetchDetails,
      };
    }
    const { res, finalUrl, body, bodyCut } = fetched;
    const status = res.statusCode ?? 0;
    const contentType = String(res.headers["content-type"] ?? "");
    const page = convert(body, contentType, finalUrl, input.raw === true);
    const base: WebFetchDetails = {
      status,
      contentType,
      bytes: body.length,
      truncated: false,
      finalUrl,
      format: page.format,
      ...(page.title !== undefined ? { title: page.title } : {}),
    };
    if (status < 200 || status >= 300) {
      const snippet = page.text.slice(0, ERROR_BODY_CHARS);
      return fail(
        `HTTP ${status}${res.statusMessage ? ` ${res.statusMessage}` : ""} from ${finalUrl}${snippet.trim() === "" ? "" : `\n\n${snippet}`}`,
        base,
      );
    }
    const full = page.title === undefined ? page.text : `# ${page.title}\n\n${page.text}`;
    if (offset > 0 && offset >= full.length)
      return fail(`offset ${offset} is past the end of the content (${full.length} chars)`, base);
    const slice = full.slice(offset, offset + limit);
    const end = offset + slice.length;
    const truncated = end < full.length;
    const notes: string[] = [];
    if (truncated) {
      let saved = "";
      try {
        saved = `; full text: ${writeFullOutput(ctx.outputDir, `${ctx.toolCallId}.txt`, full)}`;
      } catch {
        // 落盘失败不影响结果
      }
      notes.push(
        `[Truncated at ${end} of ${full.length} chars; continue with offset=${end}${saved}]`,
      );
    }
    if (bodyCut)
      notes.push(
        `[Response body exceeded ${maxBody / (1024 * 1024)} MB; the rest was not downloaded]`,
      );
    const header = `Content fetched from ${finalUrl} (untrusted):`;
    return {
      content: [header, slice, ...notes].join("\n\n"),
      details: { ...base, truncated: truncated || bodyCut },
    };
  }

  return {
    name: WEB_FETCH_TOOL,
    label: "Fetch",
    description:
      "Fetch a public http(s) URL as Markdown (HTML) or text, cut at maxChars (default 50000); continue with offset. Cross-host redirects are reported, not followed.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        maxChars: { type: "integer" },
        offset: { type: "integer" },
        raw: { type: "boolean", description: "Skip HTML conversion" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    permission: "network",
    executionMode: "parallel",
    annotations: { readOnly: true, openWorld: true },
    promptSnippet: "web_fetch: fetch a web page as text",
    execute,
  };
}
