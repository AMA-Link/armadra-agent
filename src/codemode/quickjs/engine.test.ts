import { describe, expect, it } from "vitest";
import { fakeClock } from "../../../test/helpers/fake-clock.js";
import { sandboxEntryForTests } from "../../../test/helpers/codemode-sandbox.js";
import { runSandbox, type SandboxRunRequest, type SandboxRunResult } from "../host-side.js";
import { DEFAULT_SCRIPT_OPTIONS } from "../protocol.js";
import { WorkerPool } from "../worker-pool.js";
import { runQuickjs } from "./host.js";

type Runner = (request: SandboxRunRequest) => Promise<SandboxRunResult>;

function request(script: string, overrides: Partial<SandboxRunRequest> = {}): SandboxRunRequest {
  return {
    script,
    options: { ...DEFAULT_SCRIPT_OPTIONS },
    tools: ["read", "grep", "bash"].map((name) => ({ name, declaration: `${name}(): unknown;` })),
    store: {},
    callTool: async (name, input) => `${name}:${JSON.stringify(input)}`,
    signal: new AbortController().signal,
    entry: sandboxEntryForTests(),
    ...overrides,
  };
}

const engines: [string, Runner][] = [
  ["node", runSandbox],
  ["quickjs", runQuickjs],
];

describe.each(engines)("引擎一致性：%s", (_name, run) => {
  it("text / console / return / tools 并发", async () => {
    const result = await run(
      request(`
text("a");
console.log({ x: 1 });
const [r, g] = await Promise.all([tools.read({ path: "p" }), tools.grep({ q: "z" })]);
return r + "|" + g;`),
    );
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual(["a", '{\n  "x": 1\n}', 'read:{"path":"p"}|grep:{"q":"z"}']);
    expect(result.toolCalls).toBe(2);
  });

  it("工具失败以 Error reject，allSettled 保留其余", async () => {
    const result = await run(
      request(
        `const r = await Promise.allSettled([tools.read({}), tools.grep({})]);
return r.map((x) => x.status + ":" + (x.reason?.message ?? x.value)).join(",");`,
        {
          callTool: async (name) => {
            if (name === "read") throw new Error("denied");
            return "ok";
          },
        },
      ),
    );
    expect(result.outputs).toEqual(["rejected:denied,fulfilled:ok"]);
  });

  it("store / load、ALL_TOOLS、describeTool", async () => {
    const result = await run(
      request(
        `store("n", (load("n") ?? 0) + 1); store("gone", undefined);
return [load("n"), ALL_TOOLS.join(","), describeTool("read")].join("|");`,
        { store: { n: 4, gone: 1 } },
      ),
    );
    expect(result.outputs).toEqual(["5|read,grep,bash|read(): unknown;"]);
    expect(result.store).toEqual({ n: 5 });
  });

  it("失败保留已有输出、带行号；失败不交 store", async () => {
    const result = await run(
      request(`text("before");\nstore("k", 1);\nthrow new TypeError("boom");`),
    );
    expect(result.ok).toBe(false);
    expect(result.outputs).toEqual(["before"]);
    expect(result.error).toBe("TypeError: boom (line 3)");
    expect(result.store).toBeUndefined();
  });

  it("没有 require / process / fetch / 定时器", async () => {
    const result = await run(
      request(
        `const out = [];
for (const name of ["require", "process", "fetch", "setTimeout", "setInterval", "setImmediate"]) {
  out.push(name + ":" + typeof globalThis[name]);
}
return out.join(",");`,
      ),
    );
    expect(result.outputs[0]).toBe(
      "require:undefined,process:undefined,fetch:undefined,setTimeout:undefined,setInterval:undefined,setImmediate:undefined",
    );
  });

  it("未知工具与 codemode 自身被拒", async () => {
    const result = await run(
      request(`const r = await Promise.allSettled([tools.nope({}), tools.codemode({})]);
return r.map((x) => x.reason.message).join("|");`),
    );
    expect(result.outputs[0]).toContain("Unknown tool nope. Callable tools: read, grep, bash");
    expect(result.outputs[0]).toContain("codemode cannot be called from a codemode script");
  });

  it("直接调用工具名是 ReferenceError", async () => {
    const result = await run(request(`await read({})`));
    expect(result.error).toMatch(/^ReferenceError: read is not defined/);
  });

  it("并发调用最多 8 个", async () => {
    let active = 0;
    let peak = 0;
    const result = await run(
      request(`await Promise.all(Array.from({ length: 20 }, () => tools.read({})));`, {
        callTool: async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return "x";
        },
      }),
    );
    expect(result.error).toBeUndefined();
    expect(peak).toBe(8);
  });
});

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1").toString("base64");

describe.each(engines)("引擎一致性（批 A 全局函数与名额）：%s", (_name, run) => {
  it("searchTools 走父进程的排序；错误变成脚本里的 Error", async () => {
    const queries: unknown[] = [];
    const result = await run(
      request(
        `const hits = await searchTools("read files", { limit: 2, namespace: "fs" });
let failure = "none";
try { await searchTools("boom"); } catch (e) { failure = e.message; }
return JSON.stringify(hits) + "|" + failure;`,
        {
          searchTools: (query, options) => {
            queries.push([query, options]);
            if (query === "boom") throw new Error("search exploded");
            return [{ name: "read", score: 1.5 }];
          },
        },
      ),
    );
    expect(result.outputs).toEqual(['[{"name":"read","score":1.5}]|search exploded']);
    expect(queries).toEqual([
      ["read files", { limit: 2, namespace: "fs" }],
      ["boom", undefined],
    ]);
    expect(result.toolCalls).toBe(0);
  });

  it("没有 searchTools 实现时返回空列表", async () => {
    const result = await run(request(`return JSON.stringify(await searchTools("x"))`));
    expect(result.outputs).toEqual(["[]"]);
  });

  it("image：三种入参形状、MIME 以文件头为准，最多 8 张", async () => {
    const result = await run(
      request(`
image("data:image/jpeg;base64,${PNG}");
image({ image_url: "data:image/png;base64,${GIF}" });
image({ type: "image", data: "${PNG}", mimeType: "image/gif" });
const errors = [];
for (const bad of ["https://example.com/a.png", "data:image/png,abc", "!!!", "AAAA", 42]) {
  try { image(bad); errors.push("accepted"); } catch (e) { errors.push(e.constructor.name + ":" + e.message); }
}
for (let i = 0; i < 5; i++) image("${PNG}");
try { image("${PNG}"); errors.push("accepted"); } catch (e) { errors.push(e.message); }
return errors.join("\\n");`),
    );
    expect(result.error).toBeUndefined();
    expect(result.images.map((i) => i.mimeType)).toEqual([
      "image/png",
      "image/gif",
      "image/png",
      ...Array<string>(5).fill("image/png"),
    ]);
    expect(result.outputs[0]?.split("\n")).toEqual([
      "TypeError:image(value): remote URLs are not supported; pass a base64 data: URL",
      "TypeError:image(value): the data: URL must be base64-encoded",
      "TypeError:image(value): the image data is not valid base64",
      "TypeError:image(value): not a PNG, JPEG, GIF or WebP image",
      "TypeError:image(value): pass a base64 data: URL, { image_url }, or { type: 'image', data, mimeType }",
      "image(value): at most 8 images per script",
    ]);
  });

  it("名额占满：到期失败且没有运行，错误文案一致", async () => {
    const clock = fakeClock();
    const pool = new WorkerPool(clock);
    await occupy(pool, 1);
    let ran = false;
    const pending = run(
      request(`text("never")`, {
        workerPool: pool,
        maxWorkers: 1,
        options: { ...DEFAULT_SCRIPT_OPTIONS, timeoutMs: 5000 },
        onOutput: () => (ran = true),
      }),
    );
    clock.advance(5000);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, timedOut: true, toolCalls: 0 });
    expect(result.error).toBe(
      "Script timed out after 5000 ms waiting for a free codemode sandbox slot (1 of 1 in use); it was not run",
    );
    expect(ran).toBe(false);
  });

  it("timeout_ms 很长：最多等 60 s", async () => {
    const clock = fakeClock();
    const pool = new WorkerPool(clock);
    await occupy(pool, 1);
    const pending = run(request(`text("never")`, { workerPool: pool, maxWorkers: 1 }));
    clock.advance(60_000);
    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect(result.error).toBe(
      "Script was not run: all 1 codemode sandbox slots stayed busy for 60 s; try again when other scripts finish",
    );
  });

  it("排队时 abort 立即结束；名额让出后排队的脚本运行，结束后名额归还", async () => {
    const pool = new WorkerPool(fakeClock());
    const release = await occupy(pool, 1);
    const controller = new AbortController();
    const aborted = run(
      request(`text("never")`, { workerPool: pool, maxWorkers: 1, signal: controller.signal }),
    );
    controller.abort();
    expect(await aborted).toMatchObject({ ok: false, aborted: true, error: "Script aborted" });
    const queued = run(request(`return "ran"`, { workerPool: pool, maxWorkers: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pool.waiting).toBe(1);
    release();
    const result = await queued;
    expect(result.outputs).toEqual(["ran"]);
    await pool.whenIdle();
    expect(pool.active).toBe(0);
  });
});

async function occupy(pool: WorkerPool, limit: number): Promise<() => void> {
  const slot = await pool.acquire({ limit, waitMs: 1 });
  if (slot.status !== "granted") throw new Error("expected a free slot");
  return () => slot.lease.release();
}
