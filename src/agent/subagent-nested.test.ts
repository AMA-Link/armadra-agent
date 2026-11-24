/**
 * [#317] 有限层嵌套派发（M7b）：深度与可派条件、权限不外溢、名额 park、本次运行的预算、记账与级联、
 * 续聊范围与工作流任务。多 Agent 工作流设计稿 §3。
 */

import { describe, expect, it } from "vitest";
import { AgentCatalog } from "../agents/catalog.js";
import {
  SUBAGENT_ROLE_PREAMBLE,
  SUBAGENT_ROLE_PREAMBLE_NESTED,
  agentRole,
} from "../agents/builtin.js";
import { BUILTIN_AGENTS } from "../agents/builtin.js";
import type { ApprovalBroker, ApprovalRequest } from "../permissions/types.js";
import type { SubagentRunRequest, SubagentRunner } from "../tools/types.js";
import type { SystemMessage } from "../ai/types.js";
import { createSubagentExtension } from "../cli/compose-agents.js";
import { createLimitsExtension } from "./limits.js";
import { NESTED_TASK_NOTE, brokersForChild } from "./session-subagent.js";
import { SubagentPool, registryOf, type SubagentEnvironment } from "./subagent-registry.js";
import type { Harness } from "./testing/harness.js";
import type { ScriptCall, ScriptStep } from "./testing/scripted-api.js";
import {
  agentDef,
  firstUser,
  lastIsToolResult,
  sleepTool,
  subagentHarness,
  waitUntil,
} from "./testing/subagent-harness.js";
import type { SessionEvent } from "./types.js";

type Role = (call: ScriptCall) => ScriptStep;
const task = (args: Record<string, unknown>): ScriptStep => ({
  toolCalls: [{ name: "task", args }],
});
const cost = (total: number) => ({
  usage: { cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } },
});
const counter = { running: 0, peak: 0 };

/** 按第一条 user 文本（委派的 prompt）选角色；根会话的 prompt 是 `go`。 */
function tree(roles: Record<string, Role>) {
  return (call: ScriptCall): ScriptStep =>
    (roles[firstUser(call)] ?? (() => ({ text: "ok" })))(call);
}
/** 先发工具调用，拿到结果后回 `text`。 */
const then =
  (first: ScriptStep, text: string): Role =>
  (call) =>
    lastIsToolResult(call) ? { text } : first;

interface Options {
  script: (call: ScriptCall) => ScriptStep;
  env?: Partial<SubagentEnvironment>;
  agents?: ReturnType<typeof agentDef>[];
  mode?: "default" | "full-auto";
  limits?: { maxCostUsd?: number };
  brokers?: ApprovalBroker[];
}

function nested(options: Options): Harness {
  const env: SubagentEnvironment = {
    catalog: new AgentCatalog(options.agents ?? []),
    ...options.env,
  };
  return subagentHarness({
    script: options.script,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.brokers === undefined ? {} : { brokers: options.brokers }),
    extraTools: [sleepTool(counter, 20)],
    extensions: [
      ({ core }) => (core.depth > 0 ? undefined : createSubagentExtension(core, env)),
      ({ core }) => createLimitsExtension(core, core.options.limits),
    ],
  });
}

const of = <T extends SessionEvent["type"]>(h: Harness, type: T) =>
  h.events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

/** 某个角色（按首条 user 文本）最后一次请求里最后一条工具结果的全文。 */
function lastResult(h: Harness, prompt: string): string {
  const call = h.scripted.calls.filter((c) => firstUser(c) === prompt).at(-1);
  const result = call?.context.messages.findLast((m) => m.role === "toolResult");
  return JSON.stringify(result ?? "");
}

function roleSection(h: Harness, prompt: string): string {
  const call = h.scripted.calls.find((c) => firstUser(c) === prompt);
  return String((call?.context.messages[0] as SystemMessage).sections["role"]);
}

function externalStub(log: SubagentRunRequest[]): SubagentRunner {
  return {
    id: "claude",
    async start(request) {
      log.push(request);
      return {
        id: "ext-1",
        send: async () => undefined,
        wait: async () => ({
          text: "ext ok",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: "stop",
          isError: false,
        }),
        stop: async () => undefined,
      };
    },
  };
}
const claude = agentDef("claude", { runner: "claude", source: "host" });
const runnersOf = (log: SubagentRunRequest[]) => (agent: { runner: string }) =>
  agent.runner === "claude" ? externalStub(log) : undefined;

const poolOf = (h: Harness) =>
  (registryOf(h.manager.id) as unknown as { pool: { running: number; waiting: number } }).pool;
const recordsOf = (h: Harness) =>
  (
    registryOf(h.manager.id) as unknown as {
      tasks: Map<
        string,
        { slot?: boolean; parked?: boolean; nestedActive?: number; run: Record<string, number> }
      >;
    }
  ).tasks;

describe("深度与可派条件", () => {
  it("深度 2 可派：孙任务带 parentTaskId / depth，结果逐层返回", async () => {
    const h = nested({
      script: tree({
        go: then(task({ prompt: "L1" }), "root done"),
        L1: then(task({ prompt: "L2" }), "l1 done"),
        L2: () => ({ text: "l2 done" }),
      }),
    });
    await h.session.prompt("go");
    expect(lastResult(h, "L1")).toContain("[task t2] l2 done");
    expect(lastResult(h, "go")).toContain("[task t1] l1 done");
    const starts = of(h, "subagent_start");
    expect(starts.map((e) => [e.taskId, e.parentTaskId, e.depth])).toEqual([
      ["t1", undefined, undefined],
      ["t2", "t1", 2],
    ]);
    expect(of(h, "subagent_end").map((e) => [e.taskId, e.parentTaskId, e.depth])).toEqual([
      ["t2", "t1", 2],
      ["t1", undefined, undefined],
    ]);
    // 嵌套任务的工作目录 = 父任务的
    expect(starts[1]?.cwd).toBe(starts[0]?.cwd);
  });

  it("到顶拒绝（原文案）：maxDepth 1 时子会话不可派；默认 2 时孙会话不可派", async () => {
    const one = nested({
      env: { maxDepth: 1 },
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "L2" }), "l1 done"),
      }),
    });
    await one.session.prompt("go");
    expect(lastResult(one, "L1")).toContain(
      "Sub-agents are not available here (nested tasks are not allowed).",
    );
    const two = nested({
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "L2" }), "l1 done"),
        L2: then(task({ prompt: "L3" }), "l2 done"),
      }),
    });
    await two.session.prompt("go");
    expect(lastResult(two, "L2")).toContain(
      "Sub-agents are not available here (nested tasks are not allowed).",
    );
    const three = nested({
      env: { maxDepth: 3 },
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "L2" }), "l1 done"),
        L2: then(task({ prompt: "L3" }), "l2 done"),
      }),
    });
    await three.session.prompt("go");
    expect(lastResult(three, "L2")).toContain("[task t3] ok");
  });

  it("可派子会话换嵌套前言并追加说明；不可派的前言逐字节不变", async () => {
    const h = nested({
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "L2" }), "l1 done"),
      }),
    });
    await h.session.prompt("go");
    const l1 = roleSection(h, "L1");
    expect(l1).not.toContain("do not delegate further");
    expect(l1).toBe(`${agentRole(BUILTIN_AGENTS[0]!, { nested: true })}\n\n${NESTED_TASK_NOTE}`);
    expect(l1.startsWith(SUBAGENT_ROLE_PREAMBLE_NESTED)).toBe(true);
    // 深度 2 的子会话（默认 maxDepth 2）不可派：与改动前逐字节相同
    expect(roleSection(h, "L2")).toBe(agentRole(BUILTIN_AGENTS[0]!));
    expect(roleSection(h, "L2")).toBe(SUBAGENT_ROLE_PREAMBLE);
  });
});

describe("权限不外溢（P0-1）", () => {
  const readOnlyRoot = (extra: Partial<Options> = {}) => ({
    agents: [claude],
    env: { runners: runnersOf([]) },
    ...extra,
  });

  it("只读父派 ama 子任务仍只读：写与非只读 bash 被拒且不弹审批", async () => {
    const asked: string[] = [];
    const h = nested({
      ...readOnlyRoot(),
      brokers: [{ ask: async (r) => (asked.push(r.toolName), "deny") }],
      script: tree({
        go: then(task({ prompt: "L1", agent: "explore" }), "done"),
        L1: then(task({ prompt: "L2", agent: "general" }), "l1 done"),
        L2: (call) =>
          lastIsToolResult(call)
            ? { text: "l2 done" }
            : {
                toolCalls: [
                  { name: "write", args: { path: "x" } },
                  { name: "bash", args: { command: "rm -rf build" } },
                ],
              },
      }),
    });
    await h.session.prompt("go");
    const l2 = h.scripted.calls.filter((c) => firstUser(c) === "L2").at(-1)!;
    const results = l2.context.messages.filter((m) => m.role === "toolResult");
    expect(results.map((r) => [r.toolName, r.isError])).toEqual([
      ["write", true],
      ["bash", true],
    ]);
    expect(asked).toEqual([]);
  });

  it("只读父派外部 Agent 得到 plan；根为 full-auto 时普通父派外部 Agent 仍是 full-auto", async () => {
    const log: SubagentRunRequest[] = [];
    const env = { runners: runnersOf(log) };
    const h = nested({
      agents: [claude],
      env,
      script: tree({
        go: then(task({ prompt: "L1", agent: "explore" }), "done"),
        L1: then(task({ prompt: "L2", agent: "claude" }), "l1 done"),
      }),
    });
    await h.session.prompt("go");
    expect(log).toHaveLength(1);
    expect(log[0]?.mode).toBe("plan");
    expect(log[0]).toMatchObject({ parentTaskId: "t1", depth: 2 });
    const log2: SubagentRunRequest[] = [];
    const h2 = nested({
      agents: [claude],
      env: { runners: runnersOf(log2) },
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "L2", agent: "claude" }), "l1 done"),
      }),
    });
    await h2.session.prompt("go");
    expect(log2[0]?.mode).toBe("full-auto");
  });

  it("只读父的档位改派外部 Agent 被拒（落到 ama 子会话）；显式 agent 不受此限", async () => {
    const log: SubagentRunRequest[] = [];
    const tiers = { standard: { model: "fake/echo" }, strong: { agent: "claude", model: "opus" } };
    const h = nested({
      agents: [claude],
      env: { runners: runnersOf(log), modelConfig: { models: { tiers } } },
      script: tree({
        go: then(task({ prompt: "L1", agent: "explore" }), "done"),
        L1: then(task({ prompt: "L2", tier: "strong" }), "l1 done"),
      }),
    });
    await h.session.prompt("go");
    expect(log).toEqual([]);
    expect(registryOf(h.manager.id)?.get("t2")).toMatchObject({ agent: "general", depth: 2 });
    // 对照：非只读父同样的请求会改派
    const log2: SubagentRunRequest[] = [];
    const h2 = nested({
      agents: [claude],
      env: { runners: runnersOf(log2), modelConfig: { models: { tiers } } },
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "L2", tier: "strong" }), "l1 done"),
      }),
    });
    await h2.session.prompt("go");
    expect(log2).toHaveLength(1);
  });

  it("两层审批：brokersForChild 保留内层 context，外层只补没有标过任务的请求", async () => {
    const seen: ApprovalRequest[] = [];
    const root: ApprovalBroker = { ask: async (r) => (seen.push(r), "allow") };
    const inner = brokersForChild([root], { depth: 1, parentToolCallId: "c1", taskId: "t1" });
    const outer = brokersForChild(inner, { depth: 2, parentToolCallId: "c2", taskId: "t2" });
    const request = { toolName: "write", input: {}, reason: "mode" } as unknown as ApprovalRequest;
    await outer[0]!.ask({ ...request, context: { depth: 2 } }, new AbortController().signal);
    await inner[0]!.ask({ ...request, context: { depth: 1 } }, new AbortController().signal);
    expect(seen[0]?.context).toMatchObject({ depth: 2, taskId: "t2", parentToolCallId: "c2" });
    expect(seen[1]?.context).toMatchObject({ depth: 1, taskId: "t1" });
  });

  it("两层审批（整条链）：孙任务的审批到达根 broker 时标的是孙任务", async () => {
    const seen: ApprovalRequest[] = [];
    const h = nested({
      mode: "default",
      brokers: [{ ask: async (r) => (seen.push(r), "allow") }],
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "L2" }), "l1 done"),
        L2: then({ toolCalls: [{ name: "write", args: {} }] }, "l2 done"),
      }),
    });
    await h.session.prompt("go");
    const write = seen.filter((r) => r.toolName === "write");
    expect(write).toHaveLength(1);
    expect(write[0]?.context).toMatchObject({ depth: 2, taskId: "t2" });
  });
});

describe("名额 park / unpark", () => {
  it("maxConcurrent 1 两层嵌套能完成，结束后名额归零", async () => {
    const h = nested({
      env: { maxConcurrent: 1 },
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "L2" }), "l1 done"),
      }),
    });
    await h.session.prompt("go");
    expect(lastResult(h, "go")).toContain("[task t1] l1 done");
    expect(poolOf(h).running).toBe(0);
    for (const record of recordsOf(h).values()) {
      expect(record.slot).not.toBe(true);
      expect(record.parked).not.toBe(true);
      expect(record.nestedActive ?? 0).toBe(0);
    }
  });

  it("校验失败（未知类型）不 park；名额照常", async () => {
    const h = nested({
      env: { maxConcurrent: 1 },
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "L2", agent: "nope" }), "l1 done"),
      }),
    });
    await h.session.prompt("go");
    expect(lastResult(h, "L1")).toContain('Unknown agent \\"nope\\"');
    expect(poolOf(h).running).toBe(0);
    expect(recordsOf(h).get("t1")?.nestedActive ?? 0).toBe(0);
  });

  it("子任务抛错（外部 runner 起不来）也归还名额并让父拿回名额", async () => {
    const h = nested({
      agents: [claude],
      env: {
        maxConcurrent: 1,
        runners: () => ({
          id: "claude",
          start: async () => {
            throw new Error("boom");
          },
        }),
      },
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "L2", agent: "claude" }), "l1 done"),
      }),
    });
    await h.session.prompt("go");
    expect(lastResult(h, "L1")).toContain("Sub-agent failed: boom");
    expect(lastResult(h, "go")).toContain("[task t1] l1 done");
    expect(poolOf(h).running).toBe(0);
  });

  it("取消：根被中止时嵌套任务也收尾，名额归零", async () => {
    const h = nested({
      env: { maxConcurrent: 1 },
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "L2" }), "l1 done"),
        L2: () => ({ kind: "hang" }),
      }),
    });
    const run = h.session.prompt("go");
    await waitUntil(() => registryOf(h.manager.id)?.get("t2")?.status === "running");
    await h.session.abort();
    await run;
    await waitUntil(() => registryOf(h.manager.id)?.get("t1")?.status !== "running");
    expect(registryOf(h.manager.id)?.get("t2")?.status).toBe("aborted");
    expect(poolOf(h).running).toBe(0);
  });

  it("maxPending 按根池的排队数统计，含优先等待者", async () => {
    const pool = new SubagentPool(1);
    await pool.acquire(new AbortController().signal);
    const waiting = pool.acquire(new AbortController().signal, { priority: true });
    expect(pool.waiting).toBe(1);
    pool.release();
    await waiting;
    pool.release();
  });
});

describe("本次运行的预算", () => {
  it("续聊：轮数按本次运行算、不误拒；startTurns 取上次结束时的累计", async () => {
    const h = nested({
      script: tree({
        go: then(task({ prompt: "L1", maxTurns: 6 }), "done"),
        L1: (call) => {
          const results = call.context.messages.filter((m) => m.role === "toolResult").length;
          if (results === 0) return task({ prompt: "L2" });
          if (results === 1) return task({ prompt: "again", taskId: "t2" });
          return { text: "l1 done" };
        },
      }),
    });
    await h.session.prompt("go");
    expect(lastResult(h, "L1")).toContain("[task t2]");
    expect(lastResult(h, "L1")).not.toContain("no turns left");
    const run = registryOf(h.manager.id)!.runBudget("t2")!;
    // 第 2 次运行：起点是第 1 次运行结束时的累计回合数（≥ 1），上限按父 L1 的余量（6 − 已结束的 1 回合）截
    expect(run.startTurns).toBeGreaterThanOrEqual(1);
    expect(run.maxTurns).toBe(5);
  });

  it("父回合用尽 → 拒绝子任务", async () => {
    const h = nested({
      script: tree({
        go: then(task({ prompt: "L1", maxTurns: 1 }), "done"),
        L1: then(task({ prompt: "L2" }), "l1 done"),
      }),
    });
    await h.session.prompt("go");
    // L1 的第 1 个回合还没结束时只用了 0 回合：能派；maxTurns 被截到余量 1
    expect(registryOf(h.manager.id)?.runBudget("t2")?.maxTurns).toBe(1);
  });

  it("并行兄弟预留：前两个占去 0.8，第三个被截到 0.2", async () => {
    const slow: ScriptStep = { toolCalls: [{ name: "sleep", args: {} }] };
    const h = nested({
      script: tree({
        go: then(task({ prompt: "L1", budgetUsd: 1 }), "done"),
        L1: then(
          {
            toolCalls: [
              { name: "task", args: { prompt: "A", budgetUsd: 0.4 } },
              { name: "task", args: { prompt: "B", budgetUsd: 0.4 } },
              { name: "task", args: { prompt: "C" } },
            ],
          },
          "l1 done",
        ),
        A: then(slow, "a"),
        B: then(slow, "b"),
        C: then(slow, "c"),
      }),
    });
    await h.session.prompt("go");
    const budget = (id: string) => registryOf(h.manager.id)?.runBudget(id)?.budgetUsd;
    expect(budget("t2")).toBe(0.4);
    expect(budget("t3")).toBe(0.4);
    expect(budget("t4")).toBeCloseTo(0.2, 3);
    // 全部结束后预留退还
    expect(recordsOf(h).get("t1")?.run["reservedUsd"]).toBeCloseTo(0, 6);
  });

  it("父没有预算时子任务取请求的值、不预留", async () => {
    const h = nested({
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "L2", budgetUsd: 0.3 }), "l1 done"),
      }),
    });
    await h.session.prompt("go");
    expect(registryOf(h.manager.id)?.runBudget("t2")?.budgetUsd).toBe(0.3);
    expect(recordsOf(h).get("t1")?.run["reservedUsd"]).toBe(0);
  });

  it("[budget] 行：子会话因预算停下，正文前一行说明，状态仍 completed", async () => {
    const h = nested({
      script: tree({
        go: then(task({ prompt: "L1", budgetUsd: 0.5 }), "done"),
        L1: then({ toolCalls: [{ name: "sleep", args: {} }], ...cost(0.6) }, "never"),
      }),
    });
    await h.session.prompt("go");
    const text = lastResult(h, "go");
    expect(text).toContain("[budget] stopped after spending $0.6000 of the $0.5000 budget");
    expect(registryOf(h.manager.id)?.get("t1")?.status).toBe("completed");
    expect(h.scripted.calls.filter((c) => firstUser(c) === "L1")).toHaveLength(1);
  });

  it("孙任务花费经回调记到父与祖父会话；根按每条记录自身花费求和、不重复", async () => {
    const h = nested({
      env: { maxDepth: 3 },
      script: tree({
        go: then(task({ prompt: "L1", budgetUsd: 1 }), "done"),
        L1: (call) =>
          call.context.messages.some((m) => m.role === "toolResult")
            ? { text: "l1 done" }
            : task({ prompt: "L2" }),
        L2: (call) => {
          const n = call.context.messages.filter((m) => m.role === "toolResult").length;
          return n === 0
            ? task({ prompt: "L3", budgetUsd: 0.7 })
            : n === 1
              ? task({ prompt: "L3b", budgetUsd: 0.7 })
              : { text: "l2 done" };
        },
        L3: () => ({ text: "l3", ...cost(0.6) }),
        L3b: () => ({ text: "l3b", ...cost(0.6) }),
      }),
    });
    await h.session.prompt("go");
    // L2、L1 的会话各被记 1.2（> 各自 1 的预算）：二者都在记账后被拦下，不再发下一次请求
    const calls = (prompt: string) => h.scripted.calls.filter((c) => firstUser(c) === prompt);
    expect(calls("L2")).toHaveLength(2);
    expect(calls("L1")).toHaveLength(1);
    expect(lastResult(h, "go")).toContain("[budget] stopped after spending $1.20 of the $1.00");
    const ends = of(h, "subagent_end");
    expect(ends).toHaveLength(4);
    const total = ends.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
    expect(total).toBeGreaterThan(1.19);
    expect(total).toBeLessThan(1.21);
  });

  it("根 --max-cost 计入 ama 子任务", async () => {
    const h = nested({
      limits: { maxCostUsd: 1 },
      script: tree({
        go: then(task({ prompt: "L1" }), "never"),
        L1: () => ({ text: "l1", ...cost(1.2) }),
      }),
    });
    await h.session.prompt("go");
    expect(of(h, "limit_reached")).toMatchObject([{ kind: "cost", limit: 1 }]);
    expect(of(h, "limit_reached")[0]!.value).toBeGreaterThan(1.19);
    // 超限后根不再发下一次请求
    expect(h.scripted.calls.filter((c) => firstUser(c) === "go")).toHaveLength(1);
  });
});

describe("级联取消、续聊范围与工作流任务", () => {
  it("父 stop 级联到在跑的后代", async () => {
    const h = nested({
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "L2" }), "l1 done"),
        L2: () => ({ kind: "hang" }),
      }),
    });
    const run = h.session.prompt("go");
    await waitUntil(() => registryOf(h.manager.id)?.get("t2")?.status === "running");
    await registryOf(h.manager.id)!.stop("t1");
    await run;
    expect(registryOf(h.manager.id)?.get("t1")?.status).toBe("aborted");
    expect(registryOf(h.manager.id)?.get("t2")?.status).toBe("aborted");
  });

  it("续聊范围：只能续聊自己启动的任务", async () => {
    const h = nested({
      script: (call) => {
        const prompt = firstUser(call);
        if (prompt === "go")
          return lastIsToolResult(call)
            ? call.context.messages.filter((m) => m.role === "toolResult").length === 1
              ? task({ prompt: "steal", taskId: "t2" }) // 根想续聊 L1 的子任务
              : { text: "done" }
            : task({ prompt: "L1" });
        if (prompt === "L1") return then(task({ prompt: "L2" }), "l1 done")(call);
        return { text: "ok" };
      },
    });
    await h.session.prompt("go");
    expect(lastResult(h, "go")).toContain(
      "Task t2 was started by another agent; you can only continue tasks you started.",
    );
  });

  it("嵌套任务不能向根会话的任务续聊（调用方 taskId 不匹配）", async () => {
    const h = nested({
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "x", taskId: "t1" }), "l1 done"),
      }),
    });
    await h.session.prompt("go");
    // t1 是根启动的（parentTaskId 缺省），L1 的调用方 taskId 是 t1：不匹配，且 t1 仍在运行
    expect(lastResult(h, "L1")).toMatch(/started by another agent|still running/);
  });

  it("带 workflow 的任务：模型侧续聊被拒，同一运行可续聊，不参与 background()", async () => {
    let release: (() => void) | undefined;
    const sent: string[] = [];
    const log: SubagentRunRequest[] = [];
    const h = nested({
      agents: [claude],
      env: {
        runners: () => ({
          id: "claude",
          async start(request) {
            log.push(request);
            return {
              id: "ext-1",
              send: async (text) => void sent.push(text),
              wait: () =>
                new Promise((resolve) => {
                  release = () =>
                    resolve({
                      text: "wf ok",
                      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
                      stopReason: "stop",
                      isError: false,
                    });
                }),
              stop: async () => undefined,
            };
          },
        }),
      },
      script: tree({
        go: then(task({ prompt: "steal", taskId: "t1" }), "done"),
      }),
    });
    const registry = registryOf(h.manager.id)!;
    const workflow = { runId: "r1", workflowId: "w", stepId: "s", roleId: "a" };
    const base = {
      prompt: "step",
      parentToolCallId: "c0",
      signal: new AbortController().signal,
      agent: "claude",
      background: true, // 工作流任务一律前台，即使请求了后台
      workflow,
    };
    const first = registry.run(base, () => {
      throw new Error("no ama");
    });
    await waitUntil(() => log.length === 1);
    expect(registry.get("t1")).toMatchObject({ background: false, workflow });
    expect(registry.background("t1")).toEqual([]);
    release?.();
    await first;
    // 模型侧续聊被拒
    await h.session.prompt("go");
    expect(lastResult(h, "go")).toContain(
      "Task t1 belongs to workflow run r1; it cannot be continued here.",
    );
    // 同一运行可续聊
    const again = registry.run({ ...base, prompt: "again", taskId: "t1" }, () => {
      throw new Error("no ama");
    });
    await waitUntil(() => sent.length === 1);
    release?.();
    expect((await again).isError).toBe(false);
  });

  it("嵌套任务不参与 background()", async () => {
    const h = nested({
      script: tree({
        go: then(task({ prompt: "L1" }), "done"),
        L1: then(task({ prompt: "L2" }), "l1 done"),
        L2: then({ toolCalls: [{ name: "sleep", args: {} }] }, "l2 done"),
      }),
    });
    const run = h.session.prompt("go");
    await waitUntil(() => registryOf(h.manager.id)?.get("t2")?.status === "running");
    expect(registryOf(h.manager.id)!.background("t2")).toEqual([]);
    await run;
    expect(registryOf(h.manager.id)?.get("t2")).toMatchObject({
      status: "completed",
      background: false,
    });
  });
});
