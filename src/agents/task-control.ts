/**
 * 会话 id → 任务控制面（`task_ctl` 工具、RPC `get_tasks`、`/tasks` 用）。[W5-G]
 *
 * 注册表（agent/subagent-registry.ts）建好后登记、会话 dispose 时注销。单独成文件是为了让
 * tools/task-ctl.ts 不 import agent/ 的实现（agent/tool-runner → tools/registry → task-ctl 会成环）。
 */

import type { ExtendOutcome } from "../tools/background-jobs.js";
import type { SubagentResult, TaskRegistryView } from "../tools/types.js";

/** [#267] 到达寿命上限被停止的后台任务（提醒通道取走一次）。 */
export interface ExpiredTask {
  taskId: string;
  agent: string;
  maxMs: number;
  outputFile?: string;
}

export interface TaskControl extends TaskRegistryView {
  /** 运行中是已有输出，结束后是最终文本。 */
  output(taskId: string): string | undefined;
  /**
   * 等结束、超时或 `signal` 触发（后两者返回 undefined）；未知 taskId 抛 `task_not_found`。
   * [W7-B1] 不给 signal 时由 `background()` 打断（见 `detachSignal`）。
   */
  wait(
    taskId: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<SubagentResult | undefined>;
  stop(taskId: string): Promise<SubagentResult | undefined>;
  /** [W7-B1] 前台任务转后台（不给 taskId = 全部）；返回被转后台或被打断等待的 taskId。 */
  background(taskId?: string): string[];
  /** [W7-B1] 该任务的转后台信号：`background()` 触发后 abort（下次取到新的）。 */
  detachSignal(taskId: string): AbortSignal;
  /** [W7-B1] 正在阻塞父回合的任务（前台运行中、或有 `task_ctl wait` 在等）。 */
  blocking(): string[];
  /** [#267] 给后台任务续命一次：加 `min(ms, 上限)`（ms 不给 = 一个上限）。 */
  extend(taskId: string, ms?: number): ExtendOutcome;
  /** [#267] 取走到达寿命上限、已停止且尚未通知的任务（提醒通道用）。 */
  takeExpired(): ExpiredTask[];
}

const controls = new Map<string, TaskControl>();

export function registerTaskControl(sessionId: string, control: TaskControl): void {
  controls.set(sessionId, control);
}

export function unregisterTaskControl(sessionId: string, control: TaskControl): void {
  if (controls.get(sessionId) === control) controls.delete(sessionId);
}

export function taskControl(sessionId: string): TaskControl | undefined {
  return controls.get(sessionId);
}
