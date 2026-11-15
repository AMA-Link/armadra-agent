import { describe, expect, it } from "vitest";
import type { SandboxRunRequest } from "../host-side.js";
import { DEFAULT_SCRIPT_OPTIONS } from "../protocol.js";
import { runQuickjs } from "./host.js";

function request(script: string, overrides: Partial<SandboxRunRequest> = {}): SandboxRunRequest {
  return {
    script,
    options: { ...DEFAULT_SCRIPT_OPTIONS },
    tools: ["read"].map((name) => ({ name, declaration: `${name}(): unknown;` })),
    store: {},
    callTool: async (name, input) => `${name}:${JSON.stringify(input)}`,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const opts = (timeoutMs: number) => ({ ...DEFAULT_SCRIPT_OPTIONS, timeoutMs });

describe("QuickJS 引擎：期限、内存与隔离", () => {
  it("等待永远不会落定的 Promise 立即失败", async () => {
    const started = Date.now();
    const result = await runQuickjs(request("await new Promise(() => {});"));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("can never settle");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("while (true) {} 超时后被停下", async () => {
    const started = Date.now();
    const result = await runQuickjs(request("while (true) {}", { options: opts(400) }));
    expect(result.timedOut).toBe(true);
    expect(result.error).toBe("Script timed out after 400 ms");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("while (true) await null 超时后被停下", async () => {
    const result = await runQuickjs(request("while (true) await null;", { options: opts(400) }));
    expect(result.timedOut).toBe(true);
  });

  it("abort 打断空转的脚本", async () => {
    const controller = new AbortController();
    const pending = runQuickjs(request("while (true) {}", { signal: controller.signal }));
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("等待工具结果时 abort 立即结束，并中止仍在跑的调用", async () => {
    const controller = new AbortController();
    let callSignal: AbortSignal | undefined;
    const result = await runQuickjs(
      request("await tools.read({})", {
        signal: controller.signal,
        callTool: (_name, _input, signal) => {
          callSignal = signal;
          setTimeout(() => controller.abort(), 50);
          return new Promise(() => {});
        },
      }),
    );
    expect(result.aborted).toBe(true);
    expect(callSignal?.aborted).toBe(true);
  });

  it("已 abort 的请求不起 worker", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runQuickjs(request("text(1)", { signal: controller.signal }));
    expect(result).toMatchObject({ ok: false, aborted: true, error: "Script aborted" });
  });

  it("内存上限：超出时给出与 Node 引擎相同的文案", async () => {
    const result = await runQuickjs(
      request("const a = []; while (true) a.push(new Array(100000).fill(1));", { maxHeapMb: 32 }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "Script exceeded the codemode memory limit (32 MB); process the data in smaller pieces",
    );
  });

  it("无界递归抛出可捕获的 RangeError，脚本继续运行", async () => {
    const result = await runQuickjs(
      request(`
let depth = 0;
function f() { depth++; return f() + 1; }
text("before");
try { f(); } catch (e) { text(e.name + ":" + e.message); }
text("deep enough: " + (depth > 500));
const viaMap = (n) => [n].map(viaMap);
try { viaMap(0); } catch (e) { text("map " + e.name); }
const o = { get x() { return this.x; } };
try { o.x; } catch (e) { text("getter " + e.name); }
async function g() { return await g(); }
try { await g(); } catch (e) { text("async " + e.name); }
text("after");`),
    );
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual([
      "before",
      "RangeError:Maximum call stack size exceeded",
      "deep enough: true",
      "map RangeError",
      "getter RangeError",
      "async RangeError",
      "after",
    ]);
  });

  it("未捕获的无界递归以 RangeError 结束，此前的输出保留，宿主不受影响", async () => {
    const result = await runQuickjs(request("text('kept'); function f() { return f() + 1; } f();"));
    expect(result.ok).toBe(false);
    expect(result.outputs).toEqual(["kept"]);
    expect(result.error).toMatch(/^RangeError: Maximum call stack size exceeded/);
    const after = await runQuickjs(request("return 1 + 1"));
    expect(after.outputs).toEqual(["2"]);
  });

  it("原生递归（超深 JSON）仍会陷阱：转成同一句 RangeError，输出保留", async () => {
    const result = await runQuickjs(
      request(
        `text("kept"); let o = []; for (let i = 0; i < 100000; i++) o = [o]; JSON.stringify(o);`,
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.outputs).toEqual(["kept"]);
    expect(result.error).toMatch(/^RangeError: Maximum call stack size exceeded/);
  });

  it("内建对象已冻结（Error 原型除外）", async () => {
    const result = await runQuickjs(
      request(`
const frozen = [Object, Array, Array.prototype, Object.prototype, Promise, Promise.prototype, JSON, Math, Map.prototype]
  .every((x) => Object.isFrozen(x));
Array.prototype.polluted = 1;
JSON.stringify = () => "x";
class MyError extends Error { constructor(m) { super(m); this.name = "MyError"; } }
return [frozen, [].polluted, JSON.stringify({}), new MyError("m").name].join("|");`),
    );
    expect(result.outputs).toEqual(["true||{}|MyError"]);
  });

  it("逃逸尝试拿不到 process / require / 宿主", async () => {
    const result = await runQuickjs(
      request(`
const f = (() => {}).constructor;
const got = [];
for (const body of ["return typeof process", "return typeof require", "return typeof fetch", "return typeof host"]) {
  got.push(f(body)());
}
let dyn;
try { dyn = typeof (await import("node:fs")); } catch (e) { dyn = "blocked"; }
got.push(dyn);
return got.join(",");`),
    );
    expect(result.outputs).toEqual(["undefined,undefined,undefined,undefined,blocked"]);
  });

  it("eval 留在 VM 内", async () => {
    const result = await runQuickjs(
      request('return [eval("1+2"), eval("typeof process")].join(",")'),
    );
    expect(result.outputs).toEqual(["3,undefined"]);
  });

  it("语法错误报 SyntaxError；未 await 的 Promise 拒绝不让引擎崩溃", async () => {
    const bad = await runQuickjs(request("text(1);\nconst = ;"));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/^SyntaxError/);
    const loose = await runQuickjs(
      request('tools.read({}); Promise.reject(new Error("x")); return "ok";'),
    );
    expect(loose.ok).toBe(true);
    expect(loose.outputs).toEqual(["ok"]);
  });

  it("大结果与多字节文本原样往返", async () => {
    const big = `${"字".repeat(300_000)}\u{1F600}`;
    const result = await runQuickjs(
      request("const v = await tools.read({}); return v.length + ':' + v.slice(-2);", {
        callTool: async () => big,
      }),
    );
    expect(result.outputs).toEqual([`${big.length}:\u{1F600}`]);
  });
});
