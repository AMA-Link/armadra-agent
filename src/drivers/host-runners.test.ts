/**
 * [#226] `HostApi.runners.onDone`：宿主 runner 每轮结束的事件（host-api 1.1）。
 */

import { describe, expect, it } from "vitest";
import { AgentEventBus, createHostApi, hostRunnersOf } from "../host/api-impl.js";
import { HOST_API_MINOR, HOST_API_VERSION } from "../host/types.js";
import type { RunnerDoneEvent } from "../host/types.js";
import type {
  RunnerHandle,
  SubagentResult,
  SubagentRunRequest,
  ToolRegistryApi,
} from "../tools/types.js";
import { HostRunnerRegistry } from "./host-runners.js";

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } as never;

function result(text: string, extra: Partial<SubagentResult> = {}): SubagentResult {
  return { text, usage: ZERO, stopReason: "stop", isError: false, ...extra };
}

/** 可手动落定每一轮 `wait()` 的宿主句柄。 */
function scripted(id = "sess-1") {
  const rounds: { resolve(v: SubagentResult): void; reject(e: unknown): void }[] = [];
  let current: Promise<SubagentResult> | undefined;
  const calls = { send: 0, interrupt: 0, stop: 0, wait: 0 };
  const handle = {
    id,
    extra: "kept",
    get label() {
      return `handle ${this.id}`;
    },
    async send() {
      calls.send += 1;
      current = undefined;
    },
    async interrupt() {
      calls.interrupt += 1;
      return true;
    },
    async stop() {
      calls.stop += 1;
    },
    wait(): Promise<SubagentResult> {
      calls.wait += 1;
      current ??= new Promise<SubagentResult>((resolve, reject) =>
        rounds.push({ resolve, reject }),
      );
      return current;
    },
  };
  return { handle, rounds, calls };
}

function request(extra: Partial<SubagentRunRequest> = {}): SubagentRunRequest {
  return {
    prompt: "go",
    cwd: "/w",
    mode: "default",
    taskId: "t1",
    signal: new AbortController().signal,
    onEvent: () => undefined,
    ...extra,
  };
}

function setup(handle: RunnerHandle) {
  let clock = 1_000;
  const logged: string[] = [];
  const registry = new HostRunnerRegistry({
    now: () => clock,
    log: (message) => logged.push(message),
  });
  const runner = { id: "claude", description: "canvas node", start: async () => handle };
  registry.provide(runner);
  const events: RunnerDoneEvent[] = [];
  registry.onDone((event) => void events.push(event));
  return {
    registry,
    runner,
    events,
    logged,
    tick: (ms: number) => void (clock += ms),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("HostRunnerRegistry.onDone（#226）", () => {
  it("一轮完成：runner、taskId、sessionId、轮次、状态、文本与时间", async () => {
    const { handle, rounds } = scripted();
    const s = setup(handle);
    const wrapped = await s.registry.resolve("claude")!.start(request());
    const waiting = wrapped.wait();
    s.tick(250);
    rounds[0]!.resolve(result("done: a.ts"));
    await expect(waiting).resolves.toMatchObject({ text: "done: a.ts" });
    await flush();
    expect(s.events).toEqual([
      {
        runner: "claude",
        taskId: "t1",
        sessionId: "sess-1",
        round: 1,
        status: "completed",
        isError: false,
        text: "done: a.ts",
        startedAt: 1_000,
        endedAt: 1_250,
        durationMs: 250,
      },
    ]);
  });

  it("结果自报的终态与 isError 照任务注册表的规则换算", async () => {
    for (const [extra, status] of [
      [{ isError: true }, "failed"],
      [{ status: "max_turns" }, "max_turns"],
      [{ status: "interrupted" }, "interrupted"],
      [{ status: "running" }, "completed"],
    ] as const) {
      const { handle, rounds } = scripted();
      const s = setup(handle);
      const wrapped = await s.registry.resolve("claude")!.start(request());
      const waiting = wrapped.wait();
      rounds[0]!.resolve(result("x", extra as Partial<SubagentResult>));
      await waiting;
      await flush();
      expect(s.events.map((e) => [e.status, e.isError])).toEqual([[status, status === "failed"]]);
    }
  });

  it("wait() 抛错：failed 带 error，异常原样抛给调用方", async () => {
    const { handle, rounds } = scripted();
    const s = setup(handle);
    const wrapped = await s.registry.resolve("claude")!.start(request());
    const waiting = wrapped.wait();
    rounds[0]!.reject(new Error("node closed"));
    await expect(waiting).rejects.toThrow("node closed");
    await flush();
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ status: "failed", isError: true, error: "node closed" });
    expect(s.events[0]).not.toHaveProperty("text");
  });

  it("任务 signal abort 或 stop()：aborted", async () => {
    const controller = new AbortController();
    const first = scripted();
    const s = setup(first.handle);
    const wrapped = await s.registry
      .resolve("claude")!
      .start(request({ signal: controller.signal }));
    const waiting = wrapped.wait();
    controller.abort();
    first.rounds[0]!.resolve(result("partial"));
    await waiting;

    const second = scripted("sess-2");
    const t = setup(second.handle);
    const other = await t.registry.resolve("claude")!.start(request());
    const pending = other.wait();
    await other.stop();
    expect(second.calls.stop).toBe(1);
    second.rounds[0]!.reject(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
    await flush();
    expect(s.events.map((e) => e.status)).toEqual(["aborted"]);
    expect(t.events.map((e) => [e.status, e.error])).toEqual([["aborted", "stopped"]]);
  });

  it("同一轮多次 wait() 只发一次；落定后没有新一轮的 wait() 不再发", async () => {
    const { handle, rounds, calls } = scripted();
    const s = setup(handle);
    const wrapped = await s.registry.resolve("claude")!.start(request());
    const a = wrapped.wait();
    const b = wrapped.wait();
    rounds[0]!.resolve(result("one"));
    await Promise.all([a, b]);
    await wrapped.wait();
    await flush();
    expect(calls.wait).toBe(3);
    expect(s.events).toHaveLength(1);
  });

  it("send / interrupt 之后的下一轮各发一次，轮次递增、起点为续聊时刻", async () => {
    const { handle, rounds, calls } = scripted();
    const s = setup(handle);
    const wrapped = await s.registry.resolve("claude")!.start(request());
    const first = wrapped.wait();
    rounds[0]!.resolve(result("r1"));
    await first;
    s.tick(1_000);
    await wrapped.send("more");
    s.tick(500);
    const second = wrapped.wait();
    // 运行中的 interrupt 由当前这一轮的 wait() 跟到结束，不另起一轮
    expect(await wrapped.interrupt!("again")).toBe(true);
    rounds[1]!.resolve(result("r2"));
    await second;
    // 那次 interrupt 不留下「新一轮」：落定后再 wait() 不再发
    await wrapped.wait();
    await flush();
    expect(calls).toMatchObject({ send: 1, interrupt: 1 });
    expect(s.events.map((e) => [e.round, e.text, e.startedAt, e.endedAt])).toEqual([
      [1, "r1", 1_000, 1_000],
      [2, "r2", 2_000, 2_500],
    ]);
  });

  it("其余成员原样转发（getter 以原对象为 this）；缺席的可选方法仍缺席", async () => {
    const { handle } = scripted();
    const s = setup(handle);
    const wrapped = (await s.registry.resolve("claude")!.start(request())) as RunnerHandle & {
      extra: string;
      label: string;
      message?: unknown;
    };
    expect(wrapped.id).toBe("sess-1");
    expect(wrapped.extra).toBe("kept");
    expect(wrapped.label).toBe("handle sess-1");
    expect(wrapped.message).toBeUndefined();
    const bare = {
      id: "b",
      send: async () => undefined,
      wait: async () => result(""),
      stop: async () => undefined,
    };
    const t = setup(bare);
    const plain = await t.registry.resolve("claude")!.start(request());
    expect(plain.interrupt).toBeUndefined();
  });

  it("包装按 runner 复用；get() 仍是宿主原对象；注销后 resolve 不到", () => {
    const { handle } = scripted();
    const s = setup(handle);
    const wrapped = s.registry.resolve("claude");
    expect(wrapped).toMatchObject({ id: "claude", description: "canvas node" });
    expect(s.registry.resolve("claude")).toBe(wrapped);
    expect(s.registry.get("claude")).toBe(s.runner);
    expect(s.registry.resolve("nope")).toBeUndefined();
  });

  it("处理器同步 / 异步抛错只记日志，不影响结果与其它处理器；注销后不再收到", async () => {
    const { handle, rounds } = scripted();
    const s = setup(handle);
    s.registry.onDone(() => {
      throw new Error("sync boom");
    });
    s.registry.onDone(async () => {
      throw new Error("async boom");
    });
    const late: RunnerDoneEvent[] = [];
    const off = s.registry.onDone((e) => void late.push(e));
    off();
    const wrapped = await s.registry.resolve("claude")!.start(request());
    const waiting = wrapped.wait();
    rounds[0]!.resolve(result("ok"));
    await expect(waiting).resolves.toMatchObject({ text: "ok" });
    await flush();
    expect(s.events).toHaveLength(1);
    expect(late).toEqual([]);
    expect(s.logged).toHaveLength(2);
    expect(s.logged[0]).toMatch(/runners\.onDone/);
    expect(() => s.registry.onDone("x" as never)).toThrow(/runners\.onDone/);
  });

  it("直接调用 runner（无 taskId）时载荷不带 taskId", async () => {
    const { handle, rounds } = scripted();
    const s = setup(handle);
    const { taskId: _omit, ...rest } = request();
    const wrapped = await s.registry.resolve("claude")!.start(rest);
    const waiting = wrapped.wait();
    rounds[0]!.resolve(result("ok"));
    await waiting;
    await flush();
    expect(s.events[0]).not.toHaveProperty("taskId");
  });
});

describe("HostApi：host-api 1.1（#226）", () => {
  it("主版本不变，minor 与 runners.onDone 可用；处理器异常走适配器日志", async () => {
    const logs: [string, string][] = [];
    const binding = createHostApi({
      mode: "rpc",
      session: {
        id: () => "s1",
        file: () => undefined,
        cwd: () => "/w",
        model: () => undefined,
      },
      tools: {} as ToolRegistryApi,
      bus: new AgentEventBus(),
      sendUser: async () => "queued",
      log: (level, message) => void logs.push([level, message]),
      stderr: () => undefined,
    });
    const api = binding.api;
    expect(HOST_API_VERSION).toBe(1);
    expect(api.version).toBe(1);
    expect(HOST_API_MINOR).toBe(1);
    expect(api.minor).toBe(HOST_API_MINOR);
    expect(typeof api.runners?.onDone).toBe("function");
    const { handle, rounds } = scripted();
    api.runners!.provide({ id: "node", description: "d", start: async () => handle });
    const seen: RunnerDoneEvent[] = [];
    api.runners!.onDone!((e) => void seen.push(e));
    api.runners!.onDone!(() => {
      throw new Error("boom");
    });
    const wrapped = await hostRunnersOf(api)!.resolve("node")!.start(request());
    const waiting = wrapped.wait();
    rounds[0]!.resolve(result("ok"));
    await waiting;
    await flush();
    expect(seen.map((e) => [e.runner, e.status])).toEqual([["node", "completed"]]);
    expect(logs).toHaveLength(1);
    expect(logs[0]![0]).toBe("error");
    expect(logs[0]![1]).toMatch(/runners\.onDone/);
  });
});
