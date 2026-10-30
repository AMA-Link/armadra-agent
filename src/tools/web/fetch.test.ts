/**
 * web_fetch 工具：本地 http 服务器 + 注入的 lookup / request（不出网）。
 *
 * `lookup` 把任何主机名解析成公网地址（rebind.example.com 解析成内网），`request` 校验工具传来的钉住
 * lookup 只给出检查过的地址后，改连本地服务器——从而在不放行 127.0.0.1 的前提下走通真实的 HTTP 读取。
 */

import type { LookupAddress } from "node:dns";
import { existsSync, readFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { makeTmpDir, makeToolContext } from "../../../test/helpers/tool-context.js";
import { AMA_VERSION } from "../../version.js";
import type { ToolResult } from "../types.js";
import {
  FETCH_ACCEPT,
  createWebFetchTool,
  type FetchRequest,
  type WebFetchOptions,
} from "./fetch.js";

const PUBLIC_IP = "93.184.216.34";
const HTML = `<html><head><title>Guide</title></head><body><nav>menu</nav><main><h1>Guide</h1>
<p>See <a href="/api">the API</a>.</p></main></body></html>`;
/** GBK 编码的「中文」+ meta charset。 */
const GBK_PAGE = Buffer.concat([
  Buffer.from('<html><head><meta charset="gbk"><title>t</title></head><body><p>'),
  Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
  Buffer.from("</p></body></html>"),
]);

let server: http.Server;
let port = 0;
const seen: { path: string; headers: http.IncomingHttpHeaders }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    seen.push({ path, headers: req.headers });
    const send = (status: number, type: string, body: string | Buffer, extra = {}) => {
      res.writeHead(status, { "content-type": type, ...extra });
      res.end(body);
    };
    switch (path) {
      case "/docs":
        return send(200, "text/html; charset=utf-8", HTML);
      case "/json":
        return send(200, "application/json", '{"name":"left-pad","versions":["1.3.0"]}');
      case "/text":
        return send(200, "text/plain", "plain body\n");
      case "/bin":
        return send(200, "application/octet-stream", Buffer.from([0, 1, 2, 3, 4]));
      case "/big":
        return send(200, "text/plain", "x".repeat(120_000));
      case "/gzip":
        return send(200, "text/html", gzipSync(HTML), { "content-encoding": "gzip" });
      case "/gbk":
        return send(200, "text/html", GBK_PAGE);
      case "/huge":
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("a".repeat(40_000));
        res.write("b".repeat(40_000));
        return res.end("c".repeat(40_000));
      case "/same":
        return send(302, "text/plain", "", { location: "/docs" });
      case "/upgrade":
        return send(301, "text/plain", "", { location: "https://docs.example.com/docs" });
      case "/cross":
        return send(302, "text/plain", "", { location: "https://other.example.org/x?y=1" });
      case "/cred":
        return send(302, "text/plain", "", { location: "https://u:p@docs.example.com/docs" });
      case "/loop":
        return send(302, "text/plain", "", { location: "/loop" });
      case "/missing":
        return send(404, "text/html", "<p>No such page</p>");
      case "/stall-headers":
        return; // 不回应：等首字节超时
      case "/stall-body":
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial");
        return; // 不结束：等总超时
      default:
        return send(500, "text/plain", "unexpected");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

let tmp: { dir: string; cleanup(): void };
beforeEach(() => {
  tmp = makeTmpDir();
  seen.length = 0;
});
afterEach(() => tmp.cleanup());

const lookup = async (hostname: string): Promise<LookupAddress[]> =>
  hostname === "rebind.example.com"
    ? [
        { address: PUBLIC_IP, family: 4 },
        { address: "10.0.0.7", family: 4 },
      ]
    : [{ address: PUBLIC_IP, family: 4 }];

const requested: { url: string; pinned: unknown; agent: unknown; method: unknown }[] = [];

/** 校验钉住的 lookup 后改连本地服务器（https 也按 http 连，只为走通流程）。 */
const request: FetchRequest = (url, options, onResponse) => {
  let pinned: unknown;
  (options.lookup as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void)(
    url.hostname,
    { all: true },
    (_err, addresses) => (pinned = addresses),
  );
  requested.push({ url: url.href, pinned, agent: options.agent, method: options.method });
  return http.request(
    {
      host: "127.0.0.1",
      port,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      agent: false,
    },
    onResponse,
  );
};

function tool(extra: WebFetchOptions = {}) {
  return createWebFetchTool({ lookup, request, ...extra });
}

async function run(
  input: { url: string; maxChars?: number; offset?: number; raw?: boolean },
  extra: WebFetchOptions = {},
  ctxExtra: Parameters<typeof makeToolContext>[1] = {},
): Promise<ToolResult & { text: string; details: Record<string, unknown> }> {
  const ctx = makeToolContext(tmp.dir, { outputDir: tmp.dir, ...ctxExtra });
  const result = await tool(extra).execute(input, ctx);
  return {
    ...result,
    text: typeof result.content === "string" ? result.content : "",
    details: (result.details ?? {}) as Record<string, unknown>,
  };
}

describe("web_fetch：内容", () => {
  beforeEach(() => {
    requested.length = 0;
  });

  it("HTML → Markdown：首行固定、标题、相对链接按最终 URL 解析、details 形状", async () => {
    const r = await run({ url: "https://docs.example.com/docs" });
    expect(r.isError).toBeUndefined();
    expect(r.text).toBe(
      [
        "Content fetched from https://docs.example.com/docs (untrusted):",
        "# Guide\n\n# Guide\n\nSee [the API](https://docs.example.com/api).",
      ].join("\n\n"),
    );
    expect(r.details).toEqual({
      status: 200,
      contentType: "text/html; charset=utf-8",
      bytes: Buffer.byteLength(HTML),
      truncated: false,
      finalUrl: "https://docs.example.com/docs",
      format: "markdown",
      title: "Guide",
    });
  });

  it("请求头：Accept / User-Agent / 压缩，无 cookie；只发 GET；不复用连接；钉住检查过的地址", async () => {
    await run({ url: "http://docs.example.com/text" });
    const headers = seen[0]?.headers ?? {};
    expect(headers["accept"]).toBe(FETCH_ACCEPT);
    expect(headers["user-agent"]).toBe(`ama/${AMA_VERSION}`);
    expect(headers["accept-encoding"]).toBe("gzip, deflate, br");
    expect(headers["cookie"]).toBeUndefined();
    expect(requested).toEqual([
      {
        url: "http://docs.example.com/text",
        pinned: [{ address: PUBLIC_IP, family: 4 }],
        agent: false,
        method: "GET",
      },
    ]);
  });

  it("JSON 美化、text 原样、raw 不转换、二进制不解析", async () => {
    const json = await run({ url: "https://registry.example.com/json" });
    expect(json.text).toContain('{\n  "name": "left-pad",');
    expect(json.details["format"]).toBe("json");
    const text = await run({ url: "https://registry.example.com/text" });
    expect(text.text.endsWith("plain body\n")).toBe(true);
    const raw = await run({ url: "https://docs.example.com/docs", raw: true });
    expect(raw.text).toContain("<nav>menu</nav>");
    expect(raw.details["format"]).toBe("text");
    const bin = await run({ url: "https://docs.example.com/bin" });
    expect(bin.text).toContain("Binary content (application/octet-stream, 5 bytes); not parsed.");
    expect(bin.details["format"]).toBe("binary");
  });

  it("gzip 解压；meta charset 声明的 GBK 解码", async () => {
    expect((await run({ url: "https://docs.example.com/gzip" })).text).toContain("[the API]");
    expect((await run({ url: "https://docs.example.com/gbk" })).text).toContain("中文");
  });

  it("截断：maxChars 切片、末尾说明续读 offset、全文落 outputs/<toolCallId>.txt；offset 续读", async () => {
    const first = await run({ url: "https://docs.example.com/big", maxChars: 50_000 });
    expect(first.details["truncated"]).toBe(true);
    const note =
      /\[Truncated at 50000 of 120000 chars; continue with offset=50000; full text: (.+)\]$/.exec(
        first.text,
      );
    expect(note).not.toBeNull();
    expect(existsSync(note![1]!)).toBe(true);
    expect(readFileSync(note![1]!, "utf8")).toHaveLength(120_000);
    expect(note![1]).toContain("call_1.txt");
    const last = await run({ url: "https://docs.example.com/big", offset: 100_000 });
    expect(last.details["truncated"]).toBe(false);
    expect(last.text.split("\n\n")[1]).toHaveLength(20_000);
    const past = await run({ url: "https://docs.example.com/big", offset: 120_000 });
    expect(past.isError).toBe(true);
    expect(past.text).toContain("past the end of the content (120000 chars)");
  });

  it("会话层结果上限更小时一次截到位（不超过 maxResultChars）", async () => {
    const r = await run({ url: "https://docs.example.com/big" }, {}, { maxResultChars: 10_000 });
    expect(r.text.length).toBeLessThanOrEqual(10_000);
    expect(r.text).toContain("continue with offset=9488");
  });

  it("响应体超过上限：只下载到上限并标注", async () => {
    const r = await run({ url: "https://docs.example.com/huge" }, { maxBodyBytes: 50_000 });
    expect(r.details["bytes"]).toBe(50_000);
    expect(r.details["truncated"]).toBe(true);
    expect(r.text).toContain("the rest was not downloaded");
    expect(r.text).not.toContain("bc");
    expect(r.text).not.toContain("ccc");
  });

  it("参数校验：offset / maxChars 不合法", async () => {
    expect((await run({ url: "https://a.example.com/text", offset: -1 })).isError).toBe(true);
    expect((await run({ url: "https://a.example.com/text", maxChars: 0 })).isError).toBe(true);
  });

  it("HTTP 404：isError，带状态与正文片段", async () => {
    const r = await run({ url: "https://docs.example.com/missing" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("HTTP 404 Not Found from https://docs.example.com/missing\n\nNo such page");
    expect(r.details["status"]).toBe(404);
  });
});

describe("web_fetch：地址与重定向", () => {
  beforeEach(() => {
    requested.length = 0;
  });

  it("本机 / 私网 / 元数据 URL 不发请求就拒绝", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://localhost:8080/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "file:///etc/passwd",
    ]) {
      const r = await run({ url });
      expect(r.isError, url).toBe(true);
      expect(r.text, url).toMatch(/^Cannot fetch /);
    }
    expect(requested).toEqual([]);
  });

  it("DNS 解析出的地址里夹一个内网：拒绝，不发请求（防重绑定）", async () => {
    const r = await run({ url: "https://rebind.example.com/docs" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "Cannot fetch https://rebind.example.com/docs: rebind.example.com resolves to 10.0.0.7 is a private, loopback, link-local or reserved address",
    );
    expect(requested).toEqual([]);
  });

  it("同主机重定向自动跟（逐跳重新解析与钉住），http → https 升级也跟", async () => {
    const r = await run({ url: "https://docs.example.com/same" });
    expect(r.details["finalUrl"]).toBe("https://docs.example.com/docs");
    expect(r.text).toContain("Content fetched from https://docs.example.com/docs (untrusted):");
    expect(requested.map((q) => q.url)).toEqual([
      "https://docs.example.com/same",
      "https://docs.example.com/docs",
    ]);
    expect(requested.every((q) => JSON.stringify(q.pinned).includes(PUBLIC_IP))).toBe(true);
    const up = await run({ url: "http://docs.example.com/upgrade" });
    expect(up.details["finalUrl"]).toBe("https://docs.example.com/docs");
  });

  it("跨主机重定向不跟：告诉模型目标 URL，非错误", async () => {
    const r = await run({ url: "https://docs.example.com/cross" });
    expect(r.isError).toBeUndefined();
    expect(r.text).toBe(
      "Redirected to https://other.example.org/x?y=1; call web_fetch with it if appropriate.",
    );
    expect(r.details).toMatchObject({ status: 302, finalUrl: "https://other.example.org/x?y=1" });
    expect(requested).toHaveLength(1);
  });

  it("同主机重定向逐跳重检：跳到带账号密码的 URL 被拒", async () => {
    const r = await run({ url: "https://docs.example.com/cred" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("refused: URLs with credentials");
    expect(requested).toHaveLength(1);
  });

  it("同主机超过 5 跳：报错", async () => {
    const r = await run({ url: "https://docs.example.com/loop" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("more than 5 redirects");
    expect(requested).toHaveLength(6);
  });

  it("首字节超时与总超时", async () => {
    const head = await run(
      { url: "https://docs.example.com/stall-headers" },
      { firstByteTimeoutMs: 80 },
    );
    expect(head.isError).toBe(true);
    expect(head.text).toContain("no response within 0.08s");
    const body = await run({ url: "https://docs.example.com/stall-body" }, { totalTimeoutMs: 150 });
    expect(body.isError).toBe(true);
    expect(body.text).toContain("timed out after 0.15s");
  });

  it("调用方取消：返回错误而不是挂住", async () => {
    const ctx = makeToolContext(tmp.dir);
    const pending = tool().execute({ url: "https://docs.example.com/stall-headers" }, ctx);
    setTimeout(() => ctx.controller.abort(), 30);
    const r = await pending;
    expect(r.isError).toBe(true);
  });
});

describe("web_fetch：定义", () => {
  it("权限类 network、并行、只读 + openWorld；描述与 schema 固定英文", () => {
    const t = createWebFetchTool();
    expect(t.name).toBe("web_fetch");
    expect(t.permission).toBe("network");
    expect(t.executionMode).toBe("parallel");
    expect(t.annotations).toEqual({ readOnly: true, openWorld: true });
    expect(t.parameters.required).toEqual(["url"]);
    expect(/[^\x00-\x7f]/.test(t.description + JSON.stringify(t.parameters))).toBe(false);
  });
});
