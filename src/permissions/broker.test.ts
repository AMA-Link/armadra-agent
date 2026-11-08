import { describe, expect, it } from "vitest";
import type { ApprovalBroker, ApprovalDecision, ApprovalRequest } from "./types.js";
import {
  ApprovalBrokerChain,
  authorize,
  reevaluatePendingApprovals,
  type AnsweredBy,
} from "./broker.js";
import { PermissionPipeline } from "./pipeline.js";

const req = (id = "r1"): ApprovalRequest => ({
  requestId: id,
  toolName: "bash",
  input: { command: "ls" },
  reason: "mode",
});
const signal = () => new AbortController().signal;
const answer = (d: ApprovalDecision | undefined): ApprovalBroker => ({ ask: async () => d });

describe("ApprovalBrokerChain", () => {
  it("宿主 → UI：undefined 交给下一个", async () => {
    const log: [string, ApprovalDecision, AnsweredBy][] = [];
    const chain = new ApprovalBrokerChain({
      onResolved: (r, d, by) => log.push([r.requestId, d, by]),
    });
    chain.setHostBroker(answer(undefined));
    chain.setUiBroker(answer("allow"));
    expect(await chain.ask(req(), signal())).toBe("allow");
    chain.setHostBroker(answer("deny"));
    expect(await chain.ask(req("r2"), signal())).toBe("deny");
    expect(log).toEqual([
      ["r1", "allow", "ui"],
      ["r2", "deny", "host"],
    ]);
  });

  it("没有回答者 → 无人值守 deny", async () => {
    const chain = new ApprovalBrokerChain();
    expect(chain.hasResponder()).toBe(false);
    expect(await chain.ask(req(), signal())).toBe("deny");
    chain.setUiBroker(answer(undefined));
    expect(chain.hasResponder()).toBe(true);
    expect(await chain.ask(req(), signal())).toBe("deny");
  });

  it("回答者抛错 → deny（fail-safe）", async () => {
    const warnings: string[] = [];
    const chain = new ApprovalBrokerChain({ log: (_l, m) => warnings.push(m) });
    chain.setHostBroker({ ask: async () => Promise.reject(new Error("boom")) });
    chain.setUiBroker(answer("allow"));
    expect(await chain.ask(req(), signal())).toBe("deny");
    expect(warnings[0]).toContain("boom");
  });

  it("超时 deny，且回答者收到的 signal 被 abort", async () => {
    let seen: AbortSignal | undefined;
    const by: AnsweredBy[] = [];
    const chain = new ApprovalBrokerChain({ timeoutMs: 50, onResolved: (_r, _d, b) => by.push(b) });
    chain.setUiBroker({
      ask: (_r, s) => {
        seen = s;
        return new Promise(() => undefined);
      },
    });
    expect(await chain.ask(req(), signal())).toBe("deny");
    expect(seen?.aborted).toBe(true);
    expect(by).toEqual(["timeout"]);
  });

  it("父 abort → deny", async () => {
    const chain = new ApprovalBrokerChain();
    chain.setUiBroker({ ask: () => new Promise(() => undefined) });
    const c = new AbortController();
    const p = chain.ask(req(), c.signal);
    c.abort();
    expect(await p).toBe("deny");
    const pre = new AbortController();
    pre.abort();
    expect(await chain.ask(req(), pre.signal)).toBe("deny");
  });

  it("审批串行化", async () => {
    const order: string[] = [];
    const chain = new ApprovalBrokerChain();
    chain.setUiBroker({
      ask: async (r) => {
        order.push(`start ${r.requestId}`);
        await new Promise((res) => setTimeout(res, 20));
        order.push(`end ${r.requestId}`);
        return "allow";
      },
    });
    await Promise.all([chain.ask(req("a"), signal()), chain.ask(req("b"), signal())]);
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });
});

describe("authorize", () => {
  const make = () => new PermissionPipeline({ mode: "default", rules: [], cwd: "/w" });
  const input = (unattended = false) => ({
    toolName: "bash",
    permission: "execute" as const,
    input: { command: "make build" },
    unattended,
  });

  it("allow 直接放行；deny 带说明", async () => {
    const chain = new ApprovalBrokerChain();
    const p = make();
    const read = await authorize(
      p,
      chain,
      { toolName: "read", permission: "read", input: { path: "a" }, unattended: false },
      { signal: signal() },
    );
    expect(read.allowed).toBe(true);
    const un = await authorize(p, chain, input(true), { signal: signal() });
    expect(un).toMatchObject({ allowed: false });
    expect(un.message).toContain("unattended");
  });

  it("allow_session 记忆后不再询问；hook ask 带 hookReason", async () => {
    const asked: ApprovalRequest[] = [];
    const chain = new ApprovalBrokerChain({ onRequested: (r) => asked.push(r) });
    chain.setUiBroker(answer("allow_session"));
    const p = make();
    const first = await authorize(p, chain, input(), { signal: signal(), requestId: "q1" });
    expect(first).toMatchObject({ allowed: true, decision: "allow_session" });
    const second = await authorize(p, chain, input(), { signal: signal() });
    expect(second).toMatchObject({ allowed: true, verdict: { step: "session" } });
    expect(asked.map((r) => r.requestId)).toEqual(["q1"]);

    chain.setUiBroker(answer("deny"));
    const hooked = await authorize(
      p,
      chain,
      {
        toolName: "read",
        permission: "read",
        input: { path: "x" },
        hookDecision: "ask",
        hookReason: "check this",
        unattended: false,
      },
      { signal: signal() },
    );
    expect(hooked.allowed).toBe(false);
    expect(asked.at(-1)).toMatchObject({ reason: "hook", hookReason: "check this" });
  });
});

/** [#271] 切换权限模式时重判待审批。 */
describe("ApprovalBrokerChain.reevaluatePending", () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  /** 一个永远不答、记下 signal 的 UI broker（像对话框 / RPC 客户端）。 */
  function waitingUi(): {
    broker: ApprovalBroker;
    asked: ApprovalRequest[];
    signals: AbortSignal[];
  } {
    const asked: ApprovalRequest[] = [];
    const signals: AbortSignal[] = [];
    return {
      asked,
      signals,
      broker: {
        ask: (r, s) => {
          asked.push(r);
          signals.push(s);
          return new Promise(() => undefined);
        },
      },
    };
  }
  /** 带重判闭包的请求（`gateToolCall` 的做法）。 */
  function gated(
    pipeline: PermissionPipeline,
    id: string,
    toolName: string,
    permission: "read" | "write" | "execute" | "network",
    input: unknown,
    reason: ApprovalRequest["reason"] = "mode",
  ): ApprovalRequest {
    const check = { toolName, permission, input, unattended: false };
    return {
      requestId: id,
      toolName,
      input,
      reason,
      reevaluation: { check: () => pipeline.check(check) },
    };
  }

  it("一条在等、两条在排：切到 Bypass 三条都自动允许，对话框 signal 被撤回，排队的不再开对话框", async () => {
    const pipeline = new PermissionPipeline({ mode: "default", rules: [], cwd: "/w" });
    const by: AnsweredBy[] = [];
    const chain = new ApprovalBrokerChain({ onResolved: (_r, _d, b) => by.push(b) });
    const ui = waitingUi();
    chain.setUiBroker(ui.broker);
    const answers = [
      chain.ask(gated(pipeline, "a", "bash", "execute", { command: "npm test" }), signal()),
      chain.ask(gated(pipeline, "b", "write", "write", { path: "x.txt", content: "1" }), signal()),
      chain.ask(gated(pipeline, "c", "bash", "execute", { command: "make" }), signal()),
    ];
    await tick();
    expect(ui.asked.map((r) => r.requestId)).toEqual(["a"]);
    expect(chain.pendingCount).toBe(3);
    pipeline.setMode("full-auto");
    const summary = chain.reevaluatePending("full-auto");
    expect(summary.allowed.map((r) => r.requestId)).toEqual(["a", "b", "c"]);
    expect(summary.denied).toEqual([]);
    expect(ui.signals[0]?.aborted).toBe(true);
    expect(await Promise.all(answers)).toEqual(["allow", "allow", "allow"]);
    expect(by).toEqual(["mode", "mode", "mode"]);
    expect(chain.pendingCount).toBe(0);
    await tick();
    expect(ui.asked.map((r) => r.requestId)).toEqual(["a"]);
    for (const id of ["a", "b", "c"]) {
      const request = summary.allowed.find((r) => r.requestId === id)!;
      expect(request.reevaluation?.outcome).toEqual({ mode: "full-auto", decision: "allow" });
    }
  });

  it("危险命令切到 Bypass 仍要人确认；没有重判入口的（外部 Agent）不动", async () => {
    const pipeline = new PermissionPipeline({ mode: "default", rules: [], cwd: "/w" });
    const chain = new ApprovalBrokerChain();
    const ui = waitingUi();
    chain.setUiBroker(ui.broker);
    void chain.ask(
      gated(pipeline, "d", "bash", "execute", { command: "git push --force" }, "dangerous"),
      signal(),
    );
    void chain.ask(
      { requestId: "ext", toolName: "agent:claude", input: {}, reason: "mode" },
      signal(),
    );
    await tick();
    pipeline.setMode("full-auto");
    expect(chain.reevaluatePending("full-auto")).toEqual({ allowed: [], denied: [] });
    expect(ui.signals[0]?.aborted).toBe(false);
    expect(chain.pendingCount).toBe(2);
  });

  it("切到 Plan：写入被拒绝（带说明），只读命令放行，其余保持询问", async () => {
    const pipeline = new PermissionPipeline({ mode: "default", rules: [], cwd: "/w" });
    const chain = new ApprovalBrokerChain();
    const ui = waitingUi();
    chain.setUiBroker(ui.broker);
    const write = gated(pipeline, "w", "write", "write", { path: "x.txt", content: "1" });
    const ls = gated(pipeline, "l", "bash", "execute", { command: "ls -la" });
    const fetch = gated(pipeline, "f", "web_fetch", "network", { url: "https://example.com" });
    const answers = [
      chain.ask(write, signal()),
      chain.ask(ls, signal()),
      chain.ask(fetch, signal()),
    ];
    await tick();
    pipeline.setMode("plan");
    const summary = chain.reevaluatePending("plan");
    expect(summary.denied.map((r) => r.requestId)).toEqual(["w"]);
    expect(summary.allowed.map((r) => r.requestId)).toEqual(["l"]);
    expect(write.reevaluation?.outcome).toMatchObject({ mode: "plan", decision: "deny" });
    expect(write.reevaluation?.outcome?.message).toContain("Plan mode is active");
    expect(await answers[0]).toBe("deny");
    expect(await answers[1]).toBe("allow");
    expect(chain.pendingCount).toBe(1);
    // 还在等的 web_fetch 现在轮到它开对话框
    await tick();
    expect(ui.asked.map((r) => r.requestId)).toEqual(["w", "f"]);
  });

  it("宿主 broker 已接手的不动；宿主弃权后再交给 UI 之前按新模式补判", async () => {
    const pipeline = new PermissionPipeline({ mode: "default", rules: [], cwd: "/w" });
    const chain = new ApprovalBrokerChain();
    let hostResolve!: (d: ApprovalDecision | undefined) => void;
    chain.setHostBroker({ ask: () => new Promise((r) => (hostResolve = r)) });
    const ui = waitingUi();
    chain.setUiBroker(ui.broker);
    const request = gated(pipeline, "h", "bash", "execute", { command: "make" });
    const answer = chain.ask(request, signal());
    await tick();
    pipeline.setMode("full-auto");
    expect(chain.reevaluatePending("full-auto")).toEqual({ allowed: [], denied: [] });
    expect(chain.pendingCount).toBe(1);
    hostResolve(undefined);
    expect(await answer).toBe("allow");
    expect(ui.asked).toEqual([]);
    expect(request.reevaluation?.outcome).toEqual({ mode: "full-auto", decision: "allow" });
  });

  it("先到的回答为准：模式结算后 UI 迟到的回答被忽略；人先答完的不再重判", async () => {
    const pipeline = new PermissionPipeline({ mode: "default", rules: [], cwd: "/w" });
    const chain = new ApprovalBrokerChain();
    let uiResolve!: (d: ApprovalDecision | undefined) => void;
    chain.setUiBroker({ ask: () => new Promise((r) => (uiResolve = r)) });
    const first = chain.ask(
      gated(pipeline, "p", "write", "write", { path: "a", content: "" }),
      signal(),
    );
    await tick();
    pipeline.setMode("plan");
    expect(chain.reevaluatePending("plan").denied).toHaveLength(1);
    uiResolve("allow");
    expect(await first).toBe("deny");
    pipeline.setMode("default");
    const second = chain.ask(
      gated(pipeline, "q", "write", "write", { path: "a", content: "" }),
      signal(),
    );
    await tick();
    uiResolve("deny");
    expect(await second).toBe("deny");
    pipeline.setMode("full-auto");
    expect(chain.reevaluatePending("full-auto")).toEqual({ allowed: [], denied: [] });
  });

  it("reevaluatePendingApprovals：只认链本身，返回条数", async () => {
    const pipeline = new PermissionPipeline({ mode: "default", rules: [], cwd: "/w" });
    const chain = new ApprovalBrokerChain();
    chain.setUiBroker(waitingUi().broker);
    const wrapped: ApprovalBroker = { ask: (r, s) => chain.ask(r, s) };
    void chain.ask(gated(pipeline, "x", "bash", "execute", { command: "make" }), signal());
    void chain.ask(gated(pipeline, "y", "write", "write", { path: "a", content: "" }), signal());
    await tick();
    pipeline.setMode("allowlist");
    expect(reevaluatePendingApprovals([wrapped], "allowlist")).toEqual({ allowed: 0, denied: 0 });
    expect(reevaluatePendingApprovals([chain], "allowlist")).toEqual({ allowed: 0, denied: 2 });
    expect(reevaluatePendingApprovals(undefined, "allowlist")).toEqual({ allowed: 0, denied: 0 });
  });
});
