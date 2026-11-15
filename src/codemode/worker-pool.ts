/**
 * codemode 脚本子进程的进程级并发闸门（设计 §5.5 沙箱）。
 *
 * 整个 ama 进程（所有会话、所有子 Agent）共享一个池：同时存活的沙箱子进程不超过上限（缺省 2），
 * 多出的脚本按先来先到排队。等待不超过 60 s，也不超过脚本自己的 `timeout_ms`（等待计入超时）；
 * 等待期间外层 abort 立即结束。名额在子进程**真正退出**（`close`）时才归还，而不是脚本结果落定时：
 * 结果已经给了模型，但被杀的进程树还没死透时，新脚本不该顶上去。
 *
 * 上限每次获取时重新读取：环境变量 `AMA_CODEMODE_MAX_WORKERS`（正整数）优先于配置
 * `codemode.maxWorkers`，都没有或不合法用缺省。时钟可注入，测试不用真实等待。
 */

export const DEFAULT_MAX_WORKERS = 2;
/** 排队等名额的上限（毫秒）。 */
export const MAX_WORKER_WAIT_MS = 60_000;
export const MAX_WORKERS_ENV = "AMA_CODEMODE_MAX_WORKERS";

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** 环境变量 > 配置 > 缺省 2；不是正整数的值被忽略。 */
export function resolveMaxWorkers(
  configValue: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return positiveInt(env[MAX_WORKERS_ENV]) ?? positiveInt(configValue) ?? DEFAULT_MAX_WORKERS;
}

export interface PoolClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: PoolClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface WorkerLease {
  /** 归还名额；重复调用无害。 */
  release(): void;
}

export type AcquireResult =
  | { status: "granted"; lease: WorkerLease; waitedMs: number }
  | { status: "timeout"; waitedMs: number; active: number }
  | { status: "aborted"; waitedMs: number };

export interface AcquireRequest {
  /** 同时存活的上限（调用方每次读取环境变量 / 配置后传入）。 */
  limit: number;
  /** 最多等多久（毫秒）。 */
  waitMs: number;
  signal?: AbortSignal;
}

interface Waiter {
  limit: number;
  started: number;
  settle(result: AcquireResult): void;
  cancel(): void;
}

export class WorkerPool {
  private live = 0;
  private readonly queue: Waiter[] = [];
  private idleResolvers: (() => void)[] = [];

  constructor(private readonly clock: PoolClock = realClock) {}

  /** 当前占用的名额。 */
  get active(): number {
    return this.live;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** 所有名额归还、队列为空时 resolve（测试与收尾用）。 */
  whenIdle(): Promise<void> {
    if (this.live === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  acquire(request: AcquireRequest): Promise<AcquireResult> {
    const started = this.clock.now();
    const waited = (): number => this.clock.now() - started;
    if (request.signal?.aborted === true) {
      return Promise.resolve({ status: "aborted", waitedMs: 0 });
    }
    if (this.queue.length === 0 && this.live < request.limit) {
      return Promise.resolve({ status: "granted", lease: this.take(), waitedMs: 0 });
    }
    return new Promise<AcquireResult>((resolve) => {
      let timer: unknown;
      const onAbort = (): void => {
        this.remove(waiter);
        waiter.settle({ status: "aborted", waitedMs: waited() });
        this.drain();
      };
      const waiter: Waiter = {
        limit: request.limit,
        started,
        settle: (result) => {
          waiter.cancel();
          resolve(result);
        },
        cancel: () => {
          this.clock.clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
        },
      };
      timer = this.clock.setTimeout(
        () => {
          this.remove(waiter);
          waiter.settle({ status: "timeout", waitedMs: waited(), active: this.live });
          this.drain();
        },
        Math.max(0, request.waitMs),
      );
      request.signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private take(): WorkerLease {
    this.live++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.live--;
        this.drain();
        this.notifyIdle();
      },
    };
  }

  private remove(waiter: Waiter): void {
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
  }

  /** 先来先到：队首放不进就整队等，不越过它。 */
  private drain(): void {
    for (;;) {
      const head = this.queue[0];
      if (head === undefined || this.live >= head.limit) break;
      this.queue.shift();
      head.settle({
        status: "granted",
        lease: this.take(),
        waitedMs: this.clock.now() - head.started,
      });
    }
    this.notifyIdle();
  }

  private notifyIdle(): void {
    if (this.live !== 0 || this.queue.length !== 0) return;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

/** 整个进程共享的池。 */
export const codemodeWorkerPool = new WorkerPool();
