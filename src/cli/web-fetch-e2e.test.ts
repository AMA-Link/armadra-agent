/**
 * web_fetch 组装到底（-p 无人值守）：缺省 default 模式被拒、`--allow 'web_fetch(<域名>)'` 放行、
 * full-auto 下私网 / 元数据地址仍被执行层拒绝。解析与请求注入（本地 http 服务器），不出网。
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import type { WebFetchOptions } from "../tools/web/fetch.js";

let server: http.Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>Docs</title><main><p>hello from docs</p></main>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const webFetch: WebFetchOptions = {
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  request: (url, options, onResponse) =>
    http.request(
      { host: "127.0.0.1", port, path: url.pathname, headers: options.headers, agent: false },
      onResponse,
    ),
};

let h: ComposeHarness | undefined;
afterEach(() => {
  h?.cleanup();
  hits = 0;
});

/** 跑一次 `-p`，返回工具结果；`denied` 时退出码应为 7（ToolDenied），否则 0。 */
async function fetchOnce(url: string, argv: string[] = [], denied = false): Promise<string> {
  h = composeHarness([
    { steps: [{ toolCall: { name: "web_fetch", arguments: { url } } }] },
    { text: "done" },
  ]);
  const code = await h.run(["-p", "go", "--model", "fake/echo", ...argv], { webFetch });
  expect(code).toBe(denied ? 7 : 0);
  return JSON.stringify(h.fake.calls.at(-1)?.context.messages.at(-1));
}

describe("web_fetch 无人值守", () => {
  it("缺省 default 模式：ask → deny，不发请求", async () => {
    const result = await fetchOnce("https://docs.example.com/guide", [], true);
    expect(result).toContain("unattended");
    expect(hits).toBe(0);
  });

  it("--allow 'web_fetch(example.com)'：子域放行并取回正文；别的域名仍被拒", async () => {
    const ok = await fetchOnce("https://docs.example.com/guide", [
      "--allow",
      "web_fetch(example.com)",
    ]);
    expect(ok).toContain("Content fetched from https://docs.example.com/guide (untrusted):");
    expect(ok).toContain("hello from docs");
    expect(hits).toBe(1);
    h?.cleanup();
    const other = await fetchOnce(
      "https://example.org/",
      ["--allow", "web_fetch(example.com)"],
      true,
    );
    expect(other).toContain("unattended");
    expect(hits).toBe(1);
  });

  it("full-auto：放行，但元数据 / 本机地址被执行层拒绝", async () => {
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://localhost:3000/"]) {
      const result = await fetchOnce(url, ["--permission-mode", "full-auto"]);
      expect(result, url).toContain(`Cannot fetch ${url}`);
      h?.cleanup();
    }
    expect(hits).toBe(0);
  });
});
