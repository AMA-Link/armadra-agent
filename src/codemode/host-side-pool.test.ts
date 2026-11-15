import { describe, expect, it } from "vitest";
import { fakeClock } from "../../test/helpers/fake-clock.js";
import { sandboxEntryForTests } from "../../test/helpers/codemode-sandbox.js";
import { NO_OS_SANDBOX } from "../sandbox/detect.js";
import { runSandbox, type SandboxRunRequest } from "./host-side.js";
import { DEFAULT_SCRIPT_OPTIONS } from "./protocol.js";
import { WorkerPool } from "./worker-pool.js";

function request(script: string, overrides: Partial<SandboxRunRequest> = {}): SandboxRunRequest {
  return {
    script,
    options: { ...DEFAULT_SCRIPT_OPTIONS },
    tools: [],
    store: {},
    callTool: async () => null,
    signal: new AbortController().signal,
    entry: sandboxEntryForTests(),
    os: NO_OS_SANDBOX,
    ...overrides,
  };
}

async function occupy(pool: WorkerPool, limit: number): Promise<() => void> {
  const slot = await pool.acquire({ limit, waitMs: 1 });
  if (slot.status !== "granted") throw new Error("expected a free slot");
  return () => slot.lease.release();
}

describe("runSandbox：进程级名额", () => {
  it("名额占满、脚本 timeout_ms ≤ 60 s：到期失败且没有运行，错误写明", async () => {
    const clock = fakeClock();
    const pool = new WorkerPool(clock);
    await occupy(pool, 1);
    let ran = false;
    const pending = runSandbox(
      request(`text("never")`, {
        workerPool: pool,
        maxWorkers: 1,
        options: { ...DEFAULT_SCRIPT_OPTIONS, timeoutMs: 5000 },
        onOutput: () => (ran = true),
      }),
    );
    clock.advance(5000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toBe(
      "Script timed out after 5000 ms waiting for a free codemode sandbox slot (1 of 1 in use); it was not run",
    );
    expect(ran).toBe(false);
    expect(result.toolCalls).toBe(0);
  });

  it("timeout_ms 很长：最多等 60 s，错误说明名额一直被占", async () => {
    const clock = fakeClock();
    const pool = new WorkerPool(clock);
    await occupy(pool, 2);
    await occupy(pool, 2);
    const pending = runSandbox(request(`text("never")`, { workerPool: pool, maxWorkers: 2 }));
    clock.advance(59_999);
    expect(pool.waiting).toBe(1);
    clock.advance(1);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.error).toBe(
      "Script was not run: all 2 codemode sandbox slots stayed busy for 60 s; try again when other scripts finish",
    );
  });

  it("等待中 abort：立即返回，不等到点", async () => {
    const pool = new WorkerPool(fakeClock());
    await occupy(pool, 1);
    const controller = new AbortController();
    const pending = runSandbox(
      request(`text("never")`, { workerPool: pool, maxWorkers: 1, signal: controller.signal }),
    );
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, aborted: true, error: "Script aborted" });
    expect(pool.waiting).toBe(0);
  });

  it("名额归还后排队的脚本照常运行；子进程退出后名额归零", async () => {
    const pool = new WorkerPool(fakeClock());
    const release = await occupy(pool, 1);
    const pending = runSandbox(request(`return "ran"`, { workerPool: pool, maxWorkers: 1 }));
    expect(pool.waiting).toBe(1);
    release();
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.outputs).toEqual(["ran"]);
    await pool.whenIdle();
    expect(pool.active).toBe(0);
  });

  it("同一个池里并发两个脚本、上限 1：先后运行而不是同时", async () => {
    const pool = new WorkerPool(fakeClock());
    const seen: number[] = [];
    const run = (): Promise<unknown> =>
      runSandbox(
        request(`text("x")`, {
          workerPool: pool,
          maxWorkers: 1,
          onOutput: () => seen.push(pool.active),
        }),
      );
    await Promise.all([run(), run()]);
    expect(seen).toEqual([1, 1]);
    await pool.whenIdle();
  });
});
