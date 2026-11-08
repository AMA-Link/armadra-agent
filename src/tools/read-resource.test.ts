import { afterEach, describe, expect, it, vi } from "vitest";
import { makeToolContext } from "../../test/helpers/tool-context.js";
import { createReadTool } from "./read.js";
import {
  HOST_RESOURCE_TIMEOUT_MS,
  pageResourceText,
  type HostResource,
  type HostResourceLookup,
} from "./resource-ref.js";
import { RESULT_NOTE_RESERVE } from "./truncate.js";

const ITEMS = Array.from({ length: 12 }, (_, i) => `item ${i + 1}`).join("\n");

function lookup(...resources: HostResource[]): HostResourceLookup {
  const map = new Map(resources.map((r) => [r.scheme, r]));
  return { get: (s) => map.get(s), schemes: () => [...map.keys()].sort() };
}

/** 一个按 `pageResourceText` 分页的资源；记录每次调用的参数。 */
function demo(
  text = ITEMS,
): HostResource & { calls: { path: string; offset: number; limit?: number }[] } {
  const calls: { path: string; offset: number; limit?: number }[] = [];
  return {
    scheme: "demo",
    describe: "Demo items",
    calls,
    read(path, options) {
      calls.push({
        path,
        offset: options.offset,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
      if (path !== "items") return undefined;
      return pageResourceText(text, options);
    },
  };
}

const HEADER = "Content read from demo://items (untrusted):\n\n";

afterEach(() => vi.useRealTimers());

describe("read 的宿主资源分支（#270）", () => {
  it("没有注册任何资源时 scheme://path 仍按文件路径处理（行为不变）", async () => {
    const tool = createReadTool({ resources: lookup() });
    const r = await tool.execute({ path: "demo://items" }, makeToolContext("/tmp"));
    expect(r.isError).toBe(true);
    expect(r.content).toBe("File not found: demo:/items"); // 路径规范化把 // 折成 /，与旧行为一致
  });

  it("交给宿主读：首行标注不可信，cat -n 编号，path 原样传给宿主，不登记 readFiles", async () => {
    const res = demo();
    const tool = createReadTool({ resources: lookup(res) });
    const ctx = makeToolContext("/tmp");
    const r = await tool.execute({ path: "demo://items", limit: 2 }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe(
      `${HEADER}     1\titem 1\n     2\titem 2\n\n[Showing lines 1-2 of 12. Use offset=3 to continue.]`,
    );
    expect(res.calls).toEqual([{ path: "items", offset: 1, limit: 2 }]);
    expect(ctx.readFiles.size).toBe(0);
    expect(r.details).toMatchObject({
      resource: "demo://items",
      scheme: "demo",
      firstLine: 1,
      lastLine: 2,
      total: 12,
      truncated: false,
    });
  });

  it("scheme 不区分大小写；分页续读拼回原文", async () => {
    const tool = createReadTool({ resources: lookup(demo()) });
    const ctx = makeToolContext("/tmp");
    const lines: string[] = [];
    let offset: number | undefined = 1;
    while (offset !== undefined) {
      const r = await tool.execute({ path: "Demo://items", offset, limit: 5 }, ctx);
      const text = String(r.content).slice(HEADER.length);
      const m = /\n\n\[Showing lines \d+-\d+ of 12\. Use offset=(\d+) to continue\.\]$/.exec(text);
      const body = m === null ? text : text.slice(0, m.index);
      lines.push(...body.split("\n").map((l) => l.replace(/^\s*\d+\t/, "")));
      offset = m === null ? undefined : Number(m[1]);
    }
    expect(lines.join("\n")).toBe(ITEMS);
  });

  it("宿主多给的行按 limit 丢弃并给出续读 offset；不给 total 时不写 of", async () => {
    const greedy: HostResource = {
      scheme: "demo",
      describe: "d",
      read: () => ({ text: "a\nb\nc\nd" }),
    };
    const tool = createReadTool({ resources: lookup(greedy) });
    const r = await tool.execute(
      { path: "demo://x", offset: 3, limit: 2 },
      makeToolContext("/tmp"),
    );
    expect(r.content).toBe(
      "Content read from demo://x (untrusted):\n\n     3\ta\n     4\tb\n\n[Showing lines 3-4. Use offset=5 to continue.]",
    );
  });

  it("宿主说还有下一页（next）但没超 limit：照宿主的 next 提示；没有 next 也没截断时无尾注", async () => {
    let next: number | undefined = 4;
    const res: HostResource = {
      scheme: "demo",
      describe: "d",
      read: () => ({ text: "a\nb\nc", ...(next !== undefined ? { next } : {}) }),
    };
    const tool = createReadTool({ resources: lookup(res) });
    const ctx = makeToolContext("/tmp");
    expect((await tool.execute({ path: "demo://x" }, ctx)).content).toContain(
      "[Showing lines 1-3. Use offset=4 to continue.]",
    );
    next = undefined;
    expect((await tool.execute({ path: "demo://x" }, ctx)).content).toBe(
      "Content read from demo://x (untrusted):\n\n     1\ta\n     2\tb\n     3\tc",
    );
  });

  it("头截断 2000 行与会话字节上限（toolOutputBytes）", async () => {
    const big = Array.from({ length: 2500 }, (_, i) => `x${i}`).join("\n");
    const tool = createReadTool({ resources: lookup(demo(big)) });
    const byLines = await tool.execute({ path: "demo://items" }, makeToolContext("/tmp"));
    expect(byLines.content).toContain("  2000\tx1999");
    expect(byLines.content).not.toContain("x2000\n");
    expect(byLines.content).toContain(
      "[Showing lines 1-2000 of 2500 (output limit 2000 lines reached). Use offset=2001 to continue.]",
    );
    expect(byLines.details).toMatchObject({ truncated: true, lastLine: 2000 });
    const ctx = makeToolContext("/tmp", { maxResultChars: 2048 + RESULT_NOTE_RESERVE });
    const byBytes = await tool.execute({ path: "demo://items" }, ctx);
    const text = String(byBytes.content);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048 + RESULT_NOTE_RESERVE);
    expect(text).toMatch(/\(output limit 2\.0 KB reached\)\. Use offset=\d+ to continue\.\]$/);
  });

  it("未注册的 scheme：列出已注册的；http(s) 另指向 web_fetch", async () => {
    const tool = createReadTool({
      resources: lookup(demo(), { scheme: "notes", describe: "n", read: () => undefined }),
    });
    const ctx = makeToolContext("/tmp");
    const unknown = await tool.execute({ path: "foo://bar" }, ctx);
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toBe('Unknown resource scheme "foo://"; registered: demo://, notes://');
    const url = await tool.execute({ path: "https://example.com/x" }, ctx);
    expect(url.content).toBe(
      'Unknown resource scheme "https://"; use web_fetch for http(s) URLs; registered: demo://, notes://',
    );
  });

  it("offset / limit 先校验再调宿主；offset 超出末尾；空资源", async () => {
    const res = demo();
    const tool = createReadTool({
      resources: lookup(res, { scheme: "empty", describe: "e", read: () => ({ text: "" }) }),
    });
    const ctx = makeToolContext("/tmp");
    expect((await tool.execute({ path: "demo://items", offset: 0 }, ctx)).content).toBe(
      "offset must be an integer ≥ 1",
    );
    expect((await tool.execute({ path: "demo://items", limit: 1.5 }, ctx)).content).toBe(
      "limit must be an integer ≥ 1",
    );
    expect(res.calls).toHaveLength(0);
    const beyond = await tool.execute({ path: "demo://items", offset: 13 }, ctx);
    expect(beyond.isError).toBe(true);
    expect(beyond.content).toBe("offset 13 is beyond the end of demo://items (12 lines)");
    const empty = await tool.execute({ path: "empty://x" }, ctx);
    expect(empty.isError).toBeUndefined();
    expect(empty.content).toBe("(empty://x is empty)");
  });

  it("宿主返回 undefined → not found；形状不对 → invalid result；含 NUL → 按二进制拒绝；抛错 → 带原因", async () => {
    const tool = createReadTool({
      resources: lookup(
        demo(),
        { scheme: "bad", describe: "b", read: () => ({ text: 42 }) as never },
        { scheme: "bin", describe: "b", read: () => ({ text: "a\0b" }) },
        {
          scheme: "boom",
          describe: "b",
          read: () => {
            throw new Error(`db offline ${"x".repeat(300)}`);
          },
        },
      ),
    });
    const ctx = makeToolContext("/tmp");
    const missing = await tool.execute({ path: "demo://nope" }, ctx);
    expect(missing).toMatchObject({ isError: true, content: "Resource not found: demo://nope" });
    expect(await tool.execute({ path: "bad://x" }, ctx)).toMatchObject({
      isError: true,
      content: "Cannot read bad://x: the host returned an invalid result",
    });
    expect(await tool.execute({ path: "bin://x" }, ctx)).toMatchObject({
      isError: true,
      content: "bin://x appears to be binary content; refusing to read it",
    });
    const boom = await tool.execute({ path: "boom://x" }, ctx);
    expect(boom.isError).toBe(true);
    expect(String(boom.content).startsWith("Cannot read boom://x: db offline x")).toBe(true);
    expect(String(boom.content).length).toBeLessThan(260);
  });

  it("宿主不返回：到时限按错误收场，signal 已 abort（假时钟）", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const slow: HostResource = {
      scheme: "slow",
      describe: "s",
      read: (_path, options) => {
        seen = options.signal;
        return new Promise(() => undefined);
      },
    };
    const tool = createReadTool({ resources: lookup(slow), resourceTimeoutMs: 5_000 });
    const pending = tool.execute({ path: "slow://x" }, makeToolContext("/tmp"));
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await pending;
    expect(r).toMatchObject({
      isError: true,
      content: "Cannot read slow://x: the host did not answer within 5s",
    });
    expect(seen?.aborted).toBe(true);
    expect(HOST_RESOURCE_TIMEOUT_MS).toBe(30_000);
  });

  it("会话中断：ctx.signal abort 立即收场", async () => {
    const slow: HostResource = {
      scheme: "slow",
      describe: "s",
      read: () => new Promise(() => undefined),
    };
    const tool = createReadTool({ resources: lookup(slow) });
    const ctx = makeToolContext("/tmp");
    const pending = tool.execute({ path: "slow://x" }, ctx);
    ctx.controller.abort();
    expect(await pending).toMatchObject({
      isError: true,
      content: "Cannot read slow://x: aborted",
    });
  });
});
