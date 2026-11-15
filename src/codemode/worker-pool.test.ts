import { describe, expect, it } from "vitest";
import { fakeClock } from "../../test/helpers/fake-clock.js";
import {
  DEFAULT_MAX_WORKERS,
  MAX_WORKERS_ENV,
  WorkerPool,
  resolveMaxWorkers,
} from "./worker-pool.js";

describe("resolveMaxWorkers", () => {
  it("缺省 2；配置 < 环境变量；不合法的值被忽略", () => {
    expect(resolveMaxWorkers(undefined, {})).toBe(DEFAULT_MAX_WORKERS);
    expect(resolveMaxWorkers(4, {})).toBe(4);
    expect(resolveMaxWorkers(4, { [MAX_WORKERS_ENV]: "6" })).toBe(6);
    expect(resolveMaxWorkers(4, { [MAX_WORKERS_ENV]: "0" })).toBe(4);
    expect(resolveMaxWorkers(4, { [MAX_WORKERS_ENV]: "abc" })).toBe(4);
    expect(resolveMaxWorkers(4, { [MAX_WORKERS_ENV]: "1.5" })).toBe(4);
    expect(resolveMaxWorkers(0, {})).toBe(DEFAULT_MAX_WORKERS);
    expect(resolveMaxWorkers(2.5, {})).toBe(DEFAULT_MAX_WORKERS);
  });
});

describe("WorkerPool", () => {
  it("上限内立即放行，满了按先来先到排队，归还后依次放行", async () => {
    const pool = new WorkerPool(fakeClock());
    const a = await pool.acquire({ limit: 2, waitMs: 1000 });
    const b = await pool.acquire({ limit: 2, waitMs: 1000 });
    expect([a.status, b.status]).toEqual(["granted", "granted"]);
    const order: string[] = [];
    const c = pool.acquire({ limit: 2, waitMs: 1000 }).then((r) => (order.push("c"), r));
    const d = pool.acquire({ limit: 2, waitMs: 1000 }).then((r) => (order.push("d"), r));
    expect(pool.active).toBe(2);
    expect(pool.waiting).toBe(2);
    if (a.status === "granted") a.lease.release();
    const rc = await c;
    expect(order).toEqual(["c"]);
    expect(pool.waiting).toBe(1);
    if (b.status === "granted") b.lease.release();
    const rd = await d;
    expect(order).toEqual(["c", "d"]);
    for (const r of [rc, rd]) if (r.status === "granted") r.lease.release();
    await pool.whenIdle();
    expect(pool.active).toBe(0);
  });

  it("重复 release 只归还一次", async () => {
    const pool = new WorkerPool(fakeClock());
    const a = await pool.acquire({ limit: 1, waitMs: 10 });
    if (a.status !== "granted") throw new Error("expected grant");
    a.lease.release();
    a.lease.release();
    const b = await pool.acquire({ limit: 1, waitMs: 10 });
    const c = pool.acquire({ limit: 1, waitMs: 10 });
    expect(b.status).toBe("granted");
    expect(pool.active).toBe(1);
    expect(pool.waiting).toBe(1);
    if (b.status === "granted") b.lease.release();
    expect((await c).status).toBe("granted");
  });

  it("等待到点：timeout，带已等时长与占用数，并退出队列", async () => {
    const clock = fakeClock();
    const pool = new WorkerPool(clock);
    await pool.acquire({ limit: 1, waitMs: 100 });
    const waiting = pool.acquire({ limit: 1, waitMs: 5000 });
    clock.advance(5000);
    expect(await waiting).toEqual({ status: "timeout", waitedMs: 5000, active: 1 });
    expect(pool.waiting).toBe(0);
  });

  it("等待中 abort 立即返回；已 abort 的信号不排队", async () => {
    const pool = new WorkerPool(fakeClock());
    await pool.acquire({ limit: 1, waitMs: 100 });
    const controller = new AbortController();
    const waiting = pool.acquire({ limit: 1, waitMs: 60_000, signal: controller.signal });
    controller.abort();
    expect((await waiting).status).toBe("aborted");
    expect(pool.waiting).toBe(0);
    expect((await pool.acquire({ limit: 1, waitMs: 1, signal: controller.signal })).status).toBe(
      "aborted",
    );
  });

  it("队首超时离队后，后面的等待者可以补上", async () => {
    const clock = fakeClock();
    const pool = new WorkerPool(clock);
    const a = await pool.acquire({ limit: 2, waitMs: 1 });
    await pool.acquire({ limit: 2, waitMs: 1 });
    // 队首要求上限 1（放不进），后面的上限 3
    const strict = pool.acquire({ limit: 1, waitMs: 100 });
    const loose = pool.acquire({ limit: 3, waitMs: 1000 });
    clock.advance(100);
    expect((await strict).status).toBe("timeout");
    expect((await loose).status).toBe("granted");
    if (a.status === "granted") a.lease.release();
  });

  it("等待后放行报告等了多久", async () => {
    const clock = fakeClock();
    const pool = new WorkerPool(clock);
    const a = await pool.acquire({ limit: 1, waitMs: 1 });
    const waiting = pool.acquire({ limit: 1, waitMs: 60_000 });
    clock.advance(1234);
    if (a.status === "granted") a.lease.release();
    const result = await waiting;
    expect(result.status === "granted" ? result.waitedMs : -1).toBe(1234);
  });
});
