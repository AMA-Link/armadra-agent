/**
 * 后台子 Agent 的寿命上限（#267；`subagents.backgroundMaxMs`，缺省 1 小时，0 不限）。
 *
 * 从 subagent-registry.ts 拆出（它已到 600 行）：
 * - `armLifetime`：后台启动、或前台任务转后台（#266 同批：从转换时刻起算）时起计时器；到点按 `stop` 处理
 *   （abort 该任务的 controller → 结束状态 `aborted`），并在记录上标 `expired`；
 * - `TaskNotifier` 对 aborted 不投递（发起停止的一方已知），所以到点的任务改由提醒通道报告：
 *   `takeExpiredTasks` 取走已停止、尚未通知的，`expiredTaskText` 给固定英文文案；
 * - `extendLifetime`：续命一次，增量封顶一个上限；
 * - 计时器可注入（`timers`，测试用手动时钟），分钟数由上限算出、不读墙钟。
 */

import type { ExpiredTask } from "../agents/task-control.js";
import type { TaskRecord } from "../agents/task-record.js";
import type { ExtendOutcome } from "../tools/background-jobs.js";
import { REAL_TIMERS, minutesOf, type TimeoutTimers } from "../tools/timers.js";

/** [#267] 后台子 Agent 寿命上限缺省：1 小时。 */
export const DEFAULT_SUBAGENT_BACKGROUND_MAX_MS = 3_600_000;

export interface LifetimeEnv {
  /** 0 / 不设 = 不限。 */
  backgroundMaxMs?: number;
  timers?: TimeoutTimers;
  now(): number;
}

/** 起计时器（已有寿命、不限或任务不在运行时不动）；`stop` 在到点时调用。 */
export function armLifetime(record: TaskRecord, env: LifetimeEnv, stop: () => void): void {
  const maxMs = env.backgroundMaxMs ?? 0;
  if (maxMs <= 0 || record.running === undefined || record.lifetime !== undefined) return;
  const lifetime: NonNullable<TaskRecord["lifetime"]> = {
    maxMs,
    extended: false,
    since: env.now(),
  };
  record.lifetime = lifetime;
  schedule(record, env, stop, maxMs);
}

function schedule(record: TaskRecord, env: LifetimeEnv, stop: () => void, ms: number): void {
  const timers = env.timers ?? REAL_TIMERS;
  const lifetime = record.lifetime;
  if (lifetime === undefined) return;
  lifetime.timer = timers.set(() => {
    lifetime.timer = undefined;
    if (record.running === undefined || record.lifetime !== lifetime) return;
    record.expired = { maxMs: lifetime.maxMs, taken: false };
    stop();
  }, ms);
}

/** 任务结束：清计时器与寿命记录（`expired` 保留给提醒通道）。 */
export function clearLifetime(record: TaskRecord, env: LifetimeEnv): void {
  const lifetime = record.lifetime;
  if (lifetime === undefined) return;
  if (lifetime.timer !== undefined) (env.timers ?? REAL_TIMERS).clear(lifetime.timer);
  delete record.lifetime;
}

/** 续命一次：加 `min(ms, 上限)`（ms 不给 = 一个上限），从原起点重算截止。 */
export function extendLifetime(
  record: TaskRecord | undefined,
  env: LifetimeEnv,
  stop: () => void,
  ms?: number,
): ExtendOutcome {
  if (record === undefined) return { ok: false, reason: "unknown" };
  if (record.running === undefined) return { ok: false, reason: "not_running" };
  const lifetime = record.lifetime;
  if (lifetime === undefined) return { ok: false, reason: "no_cap" };
  if (lifetime.extended) return { ok: false, reason: "already_extended" };
  const cap = lifetime.maxMs;
  const addedMs = Math.min(Math.max(ms ?? cap, 1), cap);
  lifetime.extended = true;
  lifetime.maxMs = cap + addedMs;
  if (lifetime.timer !== undefined) (env.timers ?? REAL_TIMERS).clear(lifetime.timer);
  schedule(record, env, stop, Math.max(0, lifetime.since + lifetime.maxMs - env.now()));
  return { ok: true, addedMs, totalMs: lifetime.maxMs };
}

/** 取走到点、已停止、尚未通知的任务。 */
export function takeExpiredTasks(records: Iterable<TaskRecord>): ExpiredTask[] {
  const out: ExpiredTask[] = [];
  for (const record of records) {
    const expired = record.expired;
    if (expired === undefined || expired.taken || record.running !== undefined) continue;
    expired.taken = true;
    const info = record.info;
    const task: ExpiredTask = { taskId: info.taskId, agent: info.agent, maxMs: expired.maxMs };
    if (info.outputFile !== undefined) task.outputFile = info.outputFile;
    out.push(task);
  }
  return out;
}

/** 提醒通道的固定英文文案。 */
export function expiredTaskText(task: ExpiredTask): string {
  const output =
    task.outputFile === undefined
      ? "task_ctl output has what it produced"
      : `output so far: ${task.outputFile} (task_ctl output)`;
  return `Background task ${task.taskId} (agent ${task.agent}) was stopped at its lifetime cap (${minutesOf(task.maxMs)}, subagents.backgroundMaxMs); ${output}.`;
}

/** `task_ctl extend` 的固定英文回复。 */
export function extendTaskText(taskId: string, outcome: ExtendOutcome): string {
  if (outcome.ok)
    return `Task ${taskId} lifetime extended by ${minutesOf(outcome.addedMs)}; it is now stopped after ${minutesOf(outcome.totalMs)} in total and cannot be extended again.`;
  switch (outcome.reason) {
    case "unknown":
      return `Unknown task ${taskId}.`;
    case "not_running":
      return `Task ${taskId} is not running; nothing to extend.`;
    case "no_cap":
      return `Task ${taskId} has no lifetime cap; nothing to extend.`;
    case "already_extended":
      return `Task ${taskId} was already extended once; it cannot be extended again.`;
  }
}
