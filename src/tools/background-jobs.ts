/**
 * 后台命令（docs/history/wave5-plan.md §8.3 H6，D29：不加新工具，`bash{background}` + `bash{job, action}`）。[W5-H2]
 *
 * - `start`：调用方（bash.ts）给出 `spawn(stdout)`——**进程只在 bash.ts 的 `spawnShell` 里创建**，
 *   这里只拿到 ChildProcess；stdout / stderr 直接写进 `outputPath`（文件描述符交给子进程，ama 退出也不
 *   会因管道断开而 SIGPIPE）。POSIX 自成进程组并登记（进程退出时同步 SIGKILL 残留组）。
 * - [#266] `adopt`：把一个**已在运行**的前台进程登记为后台任务（不重启）；输出由调用方继续写进
 *   `outputPath`（bash.ts 的 OutputAccumulator 落盘后逐块追加），这里只管生命周期与查询。
 * - `wait(id, timeoutMs)`：等到退出或超时；`stop(id)`：杀整棵树（SIGTERM → 宽限 → SIGKILL）；
 *   `output(id, options?)`：读输出文件尾部（缺省 2000 行 / 50 KB，调用方可传字节上限）。
 * - [#267] 寿命上限：`maxMs > 0` 时从登记时刻（转后台的从转换时刻）起计时，到点按 stop 杀树、标 `expired`，
 *   但**不**算已通知——提醒通道照常经 `takeExited` 告诉模型；`extend(id, ms)` 续命一次，增量封顶一个上限。
 *   计时器可注入（`timers`，测试用手动时钟）。
 * - 生命周期事件经 `onChange` 发出（started / exited / stopped）；`takeExited()` 取走尚未通知的已退出
 *   任务（提醒通道 reminders.ts 据此告诉模型「后台命令 jobId 已退出（码 N）」）。
 * - 按会话 id 登记（`jobsForSession`）；`disposeSessionJobs` 在会话 dispose 时回收进程树。
 */

import type { ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  exitCodeOf,
  isGroupAlive,
  killProcessTree,
  trackProcessGroup,
  untrackProcessGroup,
  type ProcessDeps,
} from "./process-tree.js";
import { REAL_TIMERS, clampTimerMs, type TimeoutTimers } from "./timers.js";
import { truncateTail, type TruncateOptions, type TruncateResult } from "./truncate.js";

export type JobStatus = "running" | "exited" | "stopped";

/** [#267] 寿命上限：从 `since`（登记时刻；转后台的 = 转换时刻）起 `maxMs`（含续命增量）；`extended` 后不能再续。 */
export interface JobLifetime {
  maxMs: number;
  extended: boolean;
  since: number;
}

export interface Job {
  id: string;
  command: string;
  cwd: string;
  pid?: number;
  outputPath: string;
  startedAt: number;
  status: JobStatus;
  /** 退出码（信号退出为 128 + signo）；运行中 undefined。 */
  exitCode?: number;
  endedAt?: number;
  /** [#266] 由前台命令转来（不重启进程）。 */
  moved?: true;
  /** [#267] 寿命上限；不设 = 不限。 */
  lifetime?: JobLifetime;
  /** [#267] 到达寿命上限被停止。 */
  expired?: true;
}

interface JobCommonOptions {
  cwd: string;
  outputPath: string;
  processDeps?: ProcessDeps;
  /** [#267] 寿命上限（毫秒）；0 / 不设 = 不限。 */
  maxMs?: number;
  /** [#267] 寿命计时器（测试注入）。 */
  timers?: TimeoutTimers;
}

export interface JobStartOptions extends JobCommonOptions {
  /** 用给定的输出文件描述符启动进程（bash.ts 的 spawnShell）。 */
  spawn(outputFd: number): ChildProcess;
}

export interface JobAdoptOptions extends JobCommonOptions {
  /** 已在运行的进程（bash.ts 前台启动的）。 */
  child: ChildProcess;
  startedAt: number;
}

export type JobChange = { phase: "started" | "exited" | "stopped"; job: Job };

/** [#267] `extend` 的结果。 */
export type ExtendOutcome =
  | { ok: true; addedMs: number; totalMs: number }
  | { ok: false; reason: "unknown" | "not_running" | "no_cap" | "already_extended" };

/** 后台 bash 的查询形状：`{ job, action: wait | stop | output | extend }`，不带 command。 */
export function isBackgroundJobQuery(toolName: string, input: unknown): boolean {
  if (toolName !== "bash" || typeof input !== "object" || input === null) return false;
  const record = input as { command?: unknown; job?: unknown };
  return typeof record.job === "string" && record.command === undefined;
}

interface Entry {
  job: Job;
  done: Promise<void>;
  notified: boolean;
  stopping: boolean;
  processDeps: ProcessDeps | undefined;
  timers: TimeoutTimers;
  lifetimeTimer?: unknown;
}

export class BackgroundJobs {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(change: JobChange) => void>();
  private seq = 0;

  start(command: string, options: JobStartOptions): Job {
    mkdirSync(dirname(options.outputPath), { recursive: true });
    const fd = openSync(options.outputPath, "a");
    let child: ChildProcess;
    try {
      child = options.spawn(fd);
    } finally {
      closeSync(fd);
    }
    return this.register(child, command, Date.now(), options, false);
  }

  /** [#266] 登记一个已在运行的前台进程（输出文件由调用方继续写）。 */
  adopt(command: string, options: JobAdoptOptions): Job {
    return this.register(options.child, command, options.startedAt, options, true);
  }

  private register(
    child: ChildProcess,
    command: string,
    startedAt: number,
    options: JobCommonOptions,
    moved: boolean,
  ): Job {
    const id = `bg${++this.seq}`;
    const job: Job = {
      id,
      command,
      cwd: options.cwd,
      outputPath: options.outputPath,
      startedAt,
      status: "running",
    };
    if (moved) job.moved = true;
    if (child.pid !== undefined) job.pid = child.pid;
    const maxMs = options.maxMs ?? 0;
    if (maxMs > 0) job.lifetime = { maxMs, extended: false, since: Date.now() };
    const isWindows = (options.processDeps?.platform ?? process.platform) === "win32";
    if (job.pid !== undefined && !isWindows) trackProcessGroup(job.pid);
    const entry: Entry = {
      job,
      notified: false,
      stopping: false,
      processDeps: options.processDeps,
      timers: options.timers ?? REAL_TIMERS,
      done: new Promise<void>((resolve) => {
        const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
          if (job.status !== "running") return resolve();
          this.clearLifetime(entry);
          job.exitCode = exitCodeOf(code, signal);
          job.endedAt = Date.now();
          job.status = entry.stopping ? "stopped" : "exited";
          const pid = job.pid;
          if (pid !== undefined && !isWindows && !isGroupAlive(pid, options.processDeps ?? {}))
            untrackProcessGroup(pid);
          this.notify({ phase: job.status === "stopped" ? "stopped" : "exited", job });
          resolve();
        };
        child.once("exit", finish);
        child.once("error", () => finish(127, null));
      }),
    };
    child.unref();
    this.entries.set(id, entry);
    if (maxMs > 0) this.armLifetime(entry, maxMs);
    this.notify({ phase: "started", job });
    return job;
  }

  get(id: string): Job | undefined {
    return this.entries.get(id)?.job;
  }

  list(): Job[] {
    return [...this.entries.values()].map((entry) => entry.job);
  }

  /** 等到退出或超时（`signal` 可提前结束等待，不杀进程）。 */
  async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<Job | undefined> {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    if (entry.job.status !== "running") return entry.job;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    await Promise.race([
      entry.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
        onAbort = () => resolve();
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    return entry.job;
  }

  async stop(id: string): Promise<Job | undefined> {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    if (entry.job.status !== "running") return entry.job;
    // 已经由调用方知道结果：停止的任务不再经提醒通道通知
    entry.notified = true;
    await this.kill(entry);
    return entry.job;
  }

  /** [#267] 续命一次：加 `min(ms, maxMs)`（ms 不给 = 一个上限）。 */
  extend(id: string, ms?: number): ExtendOutcome {
    const entry = this.entries.get(id);
    if (entry === undefined) return { ok: false, reason: "unknown" };
    const { job } = entry;
    // 正在被杀（stop / 到点）的任务不能再续
    if (job.status !== "running" || entry.stopping) return { ok: false, reason: "not_running" };
    const lifetime = job.lifetime;
    if (lifetime === undefined) return { ok: false, reason: "no_cap" };
    if (lifetime.extended) return { ok: false, reason: "already_extended" };
    const cap = lifetime.maxMs;
    const addedMs = Math.min(Math.max(ms ?? cap, 1), cap);
    lifetime.extended = true;
    lifetime.maxMs = cap + addedMs;
    // 重新起计时器：剩余时间 + 增量（用已知的截止时刻算，不读墙钟以外的状态）
    this.clearLifetime(entry);
    this.armLifetime(entry, Math.max(0, lifetime.since + lifetime.maxMs - Date.now()));
    return { ok: true, addedMs, totalMs: lifetime.maxMs };
  }

  /** 输出文件尾部（缺省 2000 行 / 50 KB；调用方可传字节上限，#155）。 */
  output(id: string, options: TruncateOptions = {}): (TruncateResult & { job: Job }) | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    let text = "";
    try {
      if (statSync(entry.job.outputPath).size > 0)
        text = readFileSync(entry.job.outputPath, "utf8");
    } catch {
      // 输出文件被删：按空输出
    }
    return { ...truncateTail(text, options), job: entry.job };
  }

  /** 取走已退出、尚未通知的任务（提醒通道用；wait 已看到退出的也算已知）。 */
  takeExited(): Job[] {
    const out: Job[] = [];
    for (const entry of this.entries.values()) {
      if (entry.job.status === "running" || entry.notified) continue;
      entry.notified = true;
      out.push(entry.job);
    }
    return out;
  }

  /** 标记为已知（模型已经通过 wait / output 看到了退出）。 */
  markSeen(id: string): void {
    const entry = this.entries.get(id);
    if (entry !== undefined && entry.job.status !== "running") entry.notified = true;
  }

  onChange(listener: (change: JobChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get running(): number {
    return this.list().filter((job) => job.status === "running").length;
  }

  /** 杀掉全部仍在运行的任务（会话 dispose）。 */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id).catch(() => undefined)));
    this.listeners.clear();
  }

  private armLifetime(entry: Entry, ms: number): void {
    entry.lifetimeTimer = entry.timers.set(() => {
      entry.lifetimeTimer = undefined;
      if (entry.job.status !== "running") return;
      // 到点按 stop 处理，但模型不知道：保留 notified = false，提醒通道会报「寿命上限」
      entry.job.expired = true;
      void this.kill(entry);
    }, clampTimerMs(ms));
  }

  private clearLifetime(entry: Entry): void {
    if (entry.lifetimeTimer === undefined) return;
    entry.timers.clear(entry.lifetimeTimer);
    entry.lifetimeTimer = undefined;
  }

  private async kill(entry: Entry): Promise<void> {
    entry.stopping = true;
    if (entry.job.pid !== undefined) await killProcessTree(entry.job.pid, entry.processDeps);
    await entry.done;
  }

  private notify(change: JobChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // 监听器异常不影响任务
      }
    }
  }
}

const registry = new Map<string, BackgroundJobs>();

/** 会话的后台任务表（按会话 id，首次使用时建）。 */
export function jobsForSession(sessionId: string): BackgroundJobs {
  let jobs = registry.get(sessionId);
  if (jobs === undefined) {
    jobs = new BackgroundJobs();
    registry.set(sessionId, jobs);
  }
  return jobs;
}

/** 已有的任务表（不新建）。 */
export function existingJobs(sessionId: string): BackgroundJobs | undefined {
  return registry.get(sessionId);
}

/** 会话 dispose：杀掉该会话仍在运行的后台任务并注销。 */
export async function disposeSessionJobs(sessionId: string): Promise<void> {
  const jobs = registry.get(sessionId);
  if (jobs === undefined) return;
  registry.delete(sessionId);
  await jobs.disposeAll();
}
