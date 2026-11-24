/**
 * 任务记录：并发池优先级、`newRecord` / `beginRun`、`startEvent` 与快照往返的树字段（#317）。
 */

import { describe, expect, it } from "vitest";
import { startHandle, type HandleContext } from "../agent/subagent-handle.js";
import type { SessionEntry } from "../session/types.js";
import type { RunnerHandle, SubagentRunRequest, TaskInfo } from "../tools/types.js";
import { BUILTIN_AGENTS } from "./builtin.js";
import { AgentCatalog } from "./catalog.js";
import {
  FIRST_PROMPT_MAX_CHARS,
  SubagentPool,
  TASK_CUSTOM_TYPE,
  beginRun,
  newRecord,
  rebuildRecords,
  recordData,
  startEvent,
  type TaskHandle,
} from "./task-record.js";

const agent = BUILTIN_AGENTS[0]!;

function info(extra: Partial<TaskInfo> = {}): TaskInfo {
  return {
    taskId: "t1",
    agent: agent.name,
    runner: "ama",
    description: "d",
    background: false,
    status: "running",
    startedAt: 1,
    ...extra,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("SubagentPool", () => {
  it("优先等待者先拿名额，同类仍按先后", async () => {
    const pool = new SubagentPool(1);
    const sig = new AbortController().signal;
    await pool.acquire(sig);
    const order: string[] = [];
    const take = (name: string, priority?: boolean): Promise<void> =>
      pool.acquire(sig, priority === undefined ? undefined : { priority }).then(() => {
        order.push(name);
      });
    const a = take("a");
    const b = take("b");
    const p1 = take("p1", true);
    const p2 = take("p2", true);
    await flush();
    expect(pool.waiting).toBe(4);
    for (let i = 0; i < 4; i++) {
      pool.release();
      await flush();
    }
    await Promise.all([a, b, p1, p2]);
    expect(order).toEqual(["p1", "p2", "a", "b"]);
  });

  it("排队中 abort 离队并抛 aborted", async () => {
    const pool = new SubagentPool(1);
    await pool.acquire(new AbortController().signal);
    const c = new AbortController();
    const waiting = pool.acquire(c.signal, { priority: true });
    const other = pool.acquire(new AbortController().signal);
    await flush();
    expect(pool.waiting).toBe(2);
    c.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
    expect(pool.waiting).toBe(1);
    pool.release();
    await other;
    expect(pool.waiting).toBe(0);
  });
});

describe("newRecord / beginRun", () => {
  it("缺省 run 与兼容签名；firstPrompt 截断", () => {
    const r = newRecord(info(), agent, "call", "/w");
    expect(r.isolation).toBe("none");
    expect(r.run).toEqual({
      startTurns: 0,
      startCostUsd: 0,
      maxTurns: agent.maxTurns,
      reservedUsd: 0,
      childSpentUsd: 0,
    });
    const long = newRecord(info(), agent, "c", "/w", "worktree", {
      firstPrompt: "x".repeat(FIRST_PROMPT_MAX_CHARS + 50),
      run: { reservedUsd: 1 },
    });
    expect(long.firstPrompt).toHaveLength(FIRST_PROMPT_MAX_CHARS);
    expect(long.run.reservedUsd).toBe(1);
  });

  it("beginRun 记本次运行起点并清预留", () => {
    const r = newRecord(info({ turns: 5, costUsd: 0.4 }), agent, "c", "/w");
    r.run.reservedUsd = 2;
    r.run.childSpentUsd = 1;
    beginRun(r, { maxTurns: 7, budgetUsd: 3 });
    expect(r.run).toEqual({
      startTurns: 5,
      startCostUsd: 0.4,
      maxTurns: 7,
      budgetUsd: 3,
      reservedUsd: 0,
      childSpentUsd: 0,
    });
    beginRun(r, { maxTurns: 9 });
    expect(r.run).not.toHaveProperty("budgetUsd");
  });
});

describe("startEvent 与快照", () => {
  const handle = { id: "s" } as TaskHandle;

  it("startEvent 带树字段，缺省不带", () => {
    const plain = startEvent(newRecord(info(), agent, "c", "/w"), handle);
    expect(plain).not.toHaveProperty("parentTaskId");
    expect(plain).not.toHaveProperty("depth");
    const nested = startEvent(
      newRecord(
        info({
          parentTaskId: "t0",
          depth: 2,
          tier: "light",
          workflow: { runId: "r", workflowId: "w", stepId: "s" } as never,
        }),
        agent,
        "c",
        "/w",
      ),
      handle,
    );
    expect(nested).toMatchObject({ parentTaskId: "t0", depth: 2, tier: "light" });
    expect(nested.workflow).toBeDefined();
  });

  it("recordData / rebuildRecords：带 firstPrompt，缺 depth 按 1", () => {
    const catalog = new AgentCatalog(BUILTIN_AGENTS);
    const r = newRecord(
      info({ status: "completed", parentTaskId: "t0", depth: 2 }),
      agent,
      "c",
      "/w",
      "none",
      {
        firstPrompt: "do it",
      },
    );
    const data = recordData(r);
    expect(data.firstPrompt).toBe("do it");
    const entry = (d: Record<string, unknown>): SessionEntry =>
      ({ type: "custom", customType: TASK_CUSTOM_TYPE, data: d }) as unknown as SessionEntry;
    const old = {
      ...recordData(newRecord(info({ taskId: "t2", status: "completed" }), agent, "c", "/w")),
    };
    const { records, seq } = rebuildRecords([entry(data), entry(old)], catalog, "/w");
    expect(seq).toBe(2);
    expect(records.get("t1")!.firstPrompt).toBe("do it");
    expect(records.get("t1")!.info.depth).toBe(2);
    expect(records.get("t1")!.info.parentTaskId).toBe("t0");
    expect(records.get("t2")!.info.depth).toBe(1);
    expect(records.get("t2")!.firstPrompt).toBeUndefined();
    expect(records.get("t2")!.run.startTurns).toBe(0);
  });
});

describe("startHandle", () => {
  it("填 parentTaskId / depth / workflow 与请求的 tier", async () => {
    let seen: SubagentRunRequest | undefined;
    const handle = {
      id: "s",
      send: async () => undefined,
      wait: async () => ({}),
    } as unknown as RunnerHandle;
    const ctx = {
      runners: () => ({
        id: "x",
        start: async (req: SubagentRunRequest) => {
          seen = req;
          return handle;
        },
      }),
      mode: "default",
      touch: () => undefined,
      emit: () => undefined,
      sink: () => ({ emit: () => undefined, log: () => undefined, now: () => 0 }),
    } as unknown as HandleContext;
    const ext = { ...agent, runner: "claude", tier: "strong" } as typeof agent;
    const wf = { runId: "r", workflowId: "w", stepId: "s" } as never;
    const rec = newRecord(
      info({ parentTaskId: "t0", depth: 2, tier: "light", workflow: wf }),
      ext,
      "c",
      "/w",
    );
    const ac = new AbortController();
    await startHandle(
      rec,
      { prompt: "p", tier: "standard" } as never,
      (() => undefined) as never,
      ac.signal,
      ctx,
    );
    expect(seen).toMatchObject({ parentTaskId: "t0", depth: 2, tier: "standard", workflow: wf });
    // 请求没给档：取 Agent 定义的档，而不是命中的 light
    const rec2 = newRecord(info(), ext, "c", "/w");
    await startHandle(rec2, { prompt: "p" } as never, (() => undefined) as never, ac.signal, ctx);
    expect(seen).toMatchObject({ depth: 1, tier: "strong" });
    expect(seen).not.toHaveProperty("parentTaskId");
  });
});
