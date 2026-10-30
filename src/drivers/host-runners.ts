/**
 * 宿主注入的 runner（`HostApi.runners.provide` 的底座，docs/history/wave5-plan.md §5.5，D17）。[W5-E → W5-EG]
 *
 * 一个宿主适配器一份（host/api-impl.ts 建，经 {@link ExternalAgents} 的 `hostRunners` 选项交给每个
 * 主会话）：宿主可以在 `create()` 里或之后任何时候 `provide`，同名替换；返回的函数注销。
 * `onChange` 供 `/agents` / RPC `get_agents` 的缓存刷新。
 *
 * [#226] `onDone`（`HostApi.runners.onDone`）：任务入口经 {@link HostRunnerRegistry.resolve} 拿到的是
 * 观察包装——句柄的每一轮（`start` 之后、每次 `send` / `interrupt` / `message` 之后）在 `wait()` 落定时
 * 发一次 {@link RunnerDoneEvent}。包装只观察：`wait()` 的结果与异常原样返回，其余成员原样转给宿主句柄；
 * 同一轮里多次 `wait()` 只发一次，落定后没有新一轮的 `wait()` 不再发。
 */

import { AmaError } from "../errors.js";
import type { HostRunner, RunnerDoneEvent } from "../host/types.js";
import { msg } from "../i18n/index.js";
import type {
  RunnerHandle,
  SubagentResult,
  SubagentRunRequest,
  SubagentStatus,
} from "../tools/types.js";

export type RunnerDoneHandler = (event: RunnerDoneEvent) => void | Promise<void>;

export interface HostRunnerRegistryOptions {
  /** 毫秒时钟（测试注入）。 */
  now?: () => number;
  /** `onDone` 处理器异常的去处；缺省丢弃。 */
  log?: (message: string, error: unknown) => void;
}

const TERMINAL: readonly SubagentStatus[] = [
  "completed",
  "failed",
  "aborted",
  "max_turns",
  "interrupted",
];

/** 与任务注册表的终态判定一致：中断优先，其次结果自报的终态，再按 `isError`。 */
function statusOf(result: SubagentResult, aborted: boolean): SubagentStatus {
  if (aborted) return "aborted";
  const own = result.status;
  if (own !== undefined && TERMINAL.includes(own as SubagentStatus)) return own as SubagentStatus;
  return result.isError ? "failed" : "completed";
}

export class HostRunnerRegistry {
  private readonly runners = new Map<string, HostRunner>();
  private readonly listeners = new Set<() => void>();
  private readonly doneHandlers = new Set<RunnerDoneHandler>();
  private readonly observed = new WeakMap<HostRunner, HostRunner>();
  private readonly now: () => number;
  private readonly log: (message: string, error: unknown) => void;

  constructor(options: HostRunnerRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  provide(runner: HostRunner): () => void {
    if (typeof runner?.id !== "string" || runner.id === "" || typeof runner.start !== "function")
      throw new AmaError("invalid_arguments", msg().drivers.host.runnerNeedsIdStart);
    this.runners.set(runner.id, runner);
    this.changed();
    return () => {
      if (this.runners.get(runner.id) !== runner) return;
      this.runners.delete(runner.id);
      this.changed();
    };
  }

  get(id: string): HostRunner | undefined {
    return this.runners.get(id);
  }

  /** [#226] 任务入口用：同 {@link get}，但返回发 `onDone` 的观察包装（同一 runner 包装复用）。 */
  resolve(id: string): HostRunner | undefined {
    const runner = this.runners.get(id);
    if (runner === undefined) return undefined;
    let wrapped = this.observed.get(runner);
    if (wrapped === undefined) {
      wrapped = this.observe(runner);
      this.observed.set(runner, wrapped);
    }
    return wrapped;
  }

  list(): HostRunner[] {
    return [...this.runners.values()];
  }

  /** 注入 / 注销时回调；返回取消订阅。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** [#226] 每轮结束时回调（`HostApi.runners.onDone`）；返回注销函数。 */
  onDone(handler: RunnerDoneHandler): () => void {
    if (typeof handler !== "function")
      throw new AmaError("invalid_arguments", msg().drivers.host.runnerDoneNeedsFunction);
    this.doneHandlers.add(handler);
    return () => void this.doneHandlers.delete(handler);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // 监听方出错不影响宿主
      }
    }
  }

  private emitDone(event: RunnerDoneEvent): void {
    for (const handler of [...this.doneHandlers]) {
      try {
        const out = handler(event);
        if (out instanceof Promise) out.catch((error: unknown) => this.fail(error));
      } catch (error) {
        this.fail(error);
      }
    }
  }

  private fail(error: unknown): void {
    this.log(msg().drivers.host.handlerFailed("runners.onDone"), error);
  }

  private observe(runner: HostRunner): HostRunner {
    return new Proxy(runner, {
      get: (target, prop) => {
        if (prop !== "start") return forward(target, prop);
        return async (request: SubagentRunRequest) =>
          this.observeHandle(target.id, request, this.now(), await target.start(request));
      },
    });
  }

  private observeHandle(
    runner: string,
    request: SubagentRunRequest,
    startedAt: number,
    handle: RunnerHandle,
  ): RunnerHandle {
    let round = 0;
    let fresh = true;
    let pending = false;
    let stopped = false;
    let roundStart = startedAt;
    const activity = (): void => {
      if (pending) return;
      fresh = true;
      roundStart = this.now();
    };
    const settle = (at: number, done: Pick<RunnerDoneEvent, "status" | "text" | "error">): void => {
      pending = false;
      const endedAt = this.now();
      const event: RunnerDoneEvent = {
        runner,
        sessionId: handle.id,
        round,
        status: done.status,
        isError: done.status === "failed" || done.status === "aborted",
        startedAt: at,
        endedAt,
        durationMs: Math.max(0, endedAt - at),
      };
      if (request.taskId !== undefined) event.taskId = request.taskId;
      if (done.text !== undefined) event.text = done.text;
      if (done.error !== undefined) event.error = done.error;
      this.emitDone(event);
    };
    const wait = (): Promise<SubagentResult> => {
      const result = handle.wait();
      if (!fresh) return result;
      fresh = false;
      pending = true;
      stopped = false;
      round += 1;
      const at = roundStart;
      const aborted = (): boolean => stopped || request.signal.aborted;
      result.then(
        (value) => settle(at, { status: statusOf(value, aborted()), text: value.text }),
        (error: unknown) =>
          settle(at, {
            status: aborted() ? "aborted" : "failed",
            error: error instanceof Error ? error.message : String(error),
          }),
      );
      return result;
    };
    return new Proxy(handle, {
      get: (target, prop) => {
        const value = forward(target, prop);
        if (prop === "wait") return wait;
        if (prop === "stop" && typeof value === "function")
          return (...args: unknown[]) => {
            if (pending) stopped = true;
            return (value as (...a: unknown[]) => unknown)(...args);
          };
        if (
          (prop === "send" || prop === "interrupt" || prop === "message") &&
          typeof value === "function"
        )
          return (...args: unknown[]) => {
            activity();
            return (value as (...a: unknown[]) => unknown)(...args);
          };
        return value;
      },
    });
  }
}

/** 原样读宿主对象的成员：getter 以原对象为 this，方法绑定到原对象。 */
function forward(target: object, prop: string | symbol): unknown {
  const value: unknown = Reflect.get(target, prop, target);
  return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
}
