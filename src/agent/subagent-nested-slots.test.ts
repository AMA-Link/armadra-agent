/**
 * [#317 / #318] 嵌套派发的名额与只读回归：只读角色续聊沿用 plan、父先结束子后收尾不泄漏名额、
 * 并发 unpark 只取回一次、maxConcurrent 1 下并行兄弟能完成、嵌套会话里的 fork 子会话不可派。
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { AgentCatalog } from "../agents/catalog.js";
import { sessionDirForCwd } from "../session/store.js";
import type { SubagentResult, SubagentRunRequest } from "../tools/types.js";
import { createSubagentExtension } from "../cli/compose-agents.js";
import { createLimitsExtension } from "./limits.js";
import { registryOf, type SubagentEnvironment } from "./subagent-registry.js";
import type { Harness } from "./testing/harness.js";
import type { ScriptCall, ScriptStep } from "./testing/scripted-api.js";
import {
  agentDef,
  firstUser,
  isChild,
  lastIsToolResult,
  sleepTool,
  subagentHarness,
  userTexts,
  waitUntil,
} from "./testing/subagent-harness.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const ok = (text = "ok"): SubagentResult => ({
  text,
  usage,
  stopReason: "stop",
  isError: false,
});
const claude = agentDef("claude", { runner: "claude", source: "host" });
const noAma = (): never => {
  throw new Error("no ama");
};
const sig = () => new AbortController().signal;
const counter = { running: 0, peak: 0 };

function make(
  env: Partial<SubagentEnvironment>,
  script: (call: ScriptCall) => ScriptStep,
  dir?: string,
): Harness {
  const full: SubagentEnvironment = { catalog: new AgentCatalog([claude]), ...env };
  return subagentHarness({
    script,
    ...(dir === undefined ? {} : { dir }),
    extraTools: [sleepTool(counter, 20)],
    extensions: [
      ({ core }) => (core.depth > 0 ? undefined : createSubagentExtension(core, full)),
      ({ core }) => createLimitsExtension(core, core.options.limits),
    ],
  });
}
const poolOf = (h: Harness) =>
  (registryOf(h.manager.id) as unknown as { pool: { running: number; waiting: number } }).pool;
const wf = (stepId: string, roleId: string) => ({
  runId: "r1",
  workflowId: "w",
  stepId,
  roleId,
});
const task = (args: Record<string, unknown>): ScriptStep => ({
  toolCalls: [{ name: "task", args }],
});

describe("只读角色续聊仍是只读（readOnly 记进任务记录）", () => {
  it("外部 runner：retain 1 释放句柄后续聊仍拿 plan，其它角色不受影响", async () => {
    const log: SubagentRunRequest[] = [];
    const h = make(
      {
        retain: 1,
        runners: () => ({
          id: "claude",
          async start(request) {
            log.push(request);
            return {
              id: `ext-${log.length}`,
              send: async () => undefined,
              wait: async () => ok(),
              stop: async () => undefined,
            };
          },
        }),
      },
      () => ({ text: "ok" }),
    );
    const registry = registryOf(h.manager.id)!;
    const base = { parentToolCallId: "c0", signal: sig(), background: false };
    const a = await registry.run(
      { ...base, prompt: "s1", agent: "claude", readOnly: true, workflow: wf("s1", "a") },
      noAma,
    );
    await registry.run({ ...base, prompt: "s2", agent: "claude", workflow: wf("s2", "b") }, noAma);
    // 调度器续聊：不再带 readOnly
    await registry.run(
      { ...base, prompt: "s3", taskId: a.taskId as string, workflow: wf("s3", "a") },
      noAma,
    );
    expect(log.map((r) => r.mode)).toEqual(["plan", "full-auto", "plan"]);
  });

  it("ama 子会话：句柄被释放、按会话文件重开后续聊仍不能写", async () => {
    home = createTmpHome("ama-m7b-ro-");
    const dir = sessionDirForCwd(home.dataDir, home.cwd);
    const h = make(
      { retain: 0 },
      (call) => {
        if (!isChild(call)) return { text: "root" };
        if (lastIsToolResult(call)) return { text: "child done" };
        return userTexts(call.context).at(-1) === "again"
          ? { toolCalls: [{ name: "write", args: { path: "x" } }] }
          : { text: "first done" };
      },
      dir,
    );
    const base = { parentToolCallId: "c0", signal: sig() };
    const first = await h.session.spawnSubagent({
      ...base,
      prompt: "first",
      readOnly: true,
      workflow: wf("s1", "a"),
    });
    await h.session.spawnSubagent({
      ...base,
      prompt: "again",
      taskId: first.taskId as string,
      workflow: wf("s2", "a"),
    });
    const calls = h.scripted.calls.filter(isChild);
    const results = calls.at(-1)!.context.messages.filter((m) => m.role === "toolResult");
    expect(results.map((r) => [r.toolName, r.isError])).toEqual([["write", true]]);
    // 记录持久化了 readOnly
    const entry = h.manager
      .branch()
      .findLast((e) => e.type === "custom" && e.customType === "ama.task");
    expect(entry).toMatchObject({ data: { readOnly: true } });
  });
});

describe("名额", () => {
  it("父先结束、子后收尾：不泄漏名额（pool.running 归零）", async () => {
    const releases: (() => void)[] = [];
    const h = make(
      {
        maxConcurrent: 1,
        runners: () => {
          let done: (v: SubagentResult) => void = () => undefined;
          const wait = new Promise<SubagentResult>((resolve) => (done = resolve));
          releases.push(() => done(ok()));
          return {
            id: "claude",
            async start() {
              return {
                id: "ext",
                send: async () => undefined,
                wait: () => wait,
                stop: async () => {
                  setTimeout(() => done({ ...ok("stopped"), isError: true }), 80);
                },
              };
            },
          };
        },
      },
      (call) =>
        firstUser(call) === "go"
          ? lastIsToolResult(call)
            ? { text: "done" }
            : task({ prompt: "L1" })
          : firstUser(call) === "L1"
            ? lastIsToolResult(call)
              ? { text: "l1 done" }
              : task({ prompt: "L2", agent: "claude" })
            : { text: "ok" },
    );
    const run = h.session.prompt("go");
    const registry = registryOf(h.manager.id)!;
    await waitUntil(() => registry.get("t2")?.status === "running" && releases.length >= 1);
    await registry.stop("t1");
    await run.catch(() => undefined);
    await waitUntil(() => registry.get("t2")?.status !== "running");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(poolOf(h).running).toBe(0);
    expect(poolOf(h).waiting).toBe(0);
  });

  it("两个 unpark 并发不多拿名额：全部结束后 pool.running 为 0", async () => {
    const releases: (() => void)[] = [];
    const h = make(
      {
        maxConcurrent: 1,
        runners: () => ({
          id: "claude",
          async start() {
            return {
              id: "ext",
              send: async () => undefined,
              wait: () =>
                new Promise<SubagentResult>((resolve) => releases.push(() => resolve(ok()))),
              stop: async () => undefined,
            };
          },
        }),
      },
      () => ({ text: "ok" }),
    );
    const registry = registryOf(h.manager.id)!;
    const spawner = { permissionMode: "default" as const, charge() {} };
    const nested = (prompt: string, signal: AbortSignal) =>
      registry.run(
        { prompt, agent: "claude", parentToolCallId: "c", signal, parentTaskId: "t1" },
        noAma,
        spawner,
      );
    const p1 = registry.run(
      { prompt: "P", agent: "claude", parentToolCallId: "c", signal: sig(), background: false },
      noAma,
    );
    await waitUntil(() => releases.length === 1);
    const pA = nested("A", sig());
    await waitUntil(() => releases.length === 2);
    // 排队的根层任务 D 拿走 A 让出的名额
    const pD = registry.run(
      { prompt: "D", agent: "claude", parentToolCallId: "c", signal: sig(), background: false },
      noAma,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    releases[1]!();
    await waitUntil(() => releases.length === 3);
    // 父的取回在等时又来一个嵌套任务 B，排队中被取消
    const ac = new AbortController();
    const pB = nested("B", ac.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    ac.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releases[2]!();
    await pD;
    await new Promise((resolve) => setTimeout(resolve, 20));
    releases[0]!();
    await p1;
    await Promise.all([pA, pB]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(poolOf(h).running).toBe(0);
  });

  it("maxConcurrent 1 下并行兄弟能完成", async () => {
    const h = make({ maxConcurrent: 1 }, (call) => {
      const prompt = firstUser(call);
      if (prompt === "go")
        return lastIsToolResult(call) ? { text: "done" } : task({ prompt: "L1" });
      if (prompt === "L1")
        return lastIsToolResult(call)
          ? { text: "l1 done" }
          : {
              toolCalls: [
                { name: "task", args: { prompt: "A" } },
                { name: "task", args: { prompt: "B" } },
                { name: "task", args: { prompt: "C" } },
              ],
            };
      return lastIsToolResult(call)
        ? { text: `${prompt} done` }
        : { toolCalls: [{ name: "sleep", args: {} }] };
    });
    await h.session.prompt("go");
    const registry = registryOf(h.manager.id)!;
    expect(["t1", "t2", "t3", "t4"].map((id) => registry.get(id)?.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(poolOf(h).running).toBe(0);
  });
});

describe("嵌套会话里的 fork 子会话", () => {
  it("可派的 fresh 子会话派出的 fork 子会话仍拒绝 task（#191 文案）", async () => {
    const h = make({}, (call) => {
      const prompt = firstUser(call);
      if (prompt === "go")
        return lastIsToolResult(call) ? { text: "done" } : task({ prompt: "L1" });
      if (prompt === "L1")
        return lastIsToolResult(call)
          ? { text: "l1 done" }
          : task({ prompt: "forked work", context: "fork" });
      return lastIsToolResult(call) ? { text: "fork done" } : task({ prompt: "again" });
    });
    await h.session.prompt("go");
    const text = JSON.stringify(
      h.scripted.calls
        .filter((c) => c.context.messages.at(-1)?.role === "toolResult")
        .flatMap((c) => c.context.messages.filter((m) => m.role === "toolResult")),
    );
    expect(text).toContain("you are a sub-agent forked from the main conversation");
  });
});
