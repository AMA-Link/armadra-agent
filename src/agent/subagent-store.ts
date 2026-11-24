/**
 * 子 Agent 记录的落盘、句柄保留与输出路径（从 subagent-registry.ts 拆出，行为不变）。
 *
 * - 输出路径：长结果全文落 `<outputDir>/<会话 id>-<taskId>.md`（会话没有输出目录时用系统临时目录）。
 * - 持久化：任务快照写进父会话 `custom{ama.task}` 条目（resume 时重建）。
 * - 保留：句柄 LRU，超出 `retain` 个时释放最久未用、空闲的子会话（JSONL 仍在，续聊时重开）。
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_CUSTOM_TYPE, recordData, type TaskRecord } from "../agents/task-record.js";
import type { SessionCore } from "./session-core.js";

export const DEFAULT_RETAINED = 4;

type StoreHost = Pick<SessionCore, "manager" | "appendEntry" | "outputDir" | "log">;

export class SubagentStore {
  private readonly retained: string[] = [];

  constructor(
    private readonly host: StoreHost,
    private readonly tasks: Map<string, TaskRecord>,
    private readonly isDisposed: () => boolean,
    private readonly retainLimit: () => number | undefined,
  ) {}

  outputDirectory(): string {
    return this.host.outputDir() ?? join(tmpdir(), "ama-outputs");
  }

  outputName(taskId: string): string {
    return `${this.host.manager.id}-${taskId}.md`;
  }

  outputFileFor(taskId: string): string | undefined {
    return join(this.outputDirectory(), this.outputName(taskId));
  }

  persist(record: TaskRecord): void {
    if (this.isDisposed()) return;
    try {
      this.host.appendEntry({
        type: "custom",
        customType: TASK_CUSTOM_TYPE,
        data: recordData(record),
      });
    } catch (error) {
      this.host.log("warn", `could not record task ${record.info.taskId}: ${String(error)}`);
    }
  }

  touch(taskId: string): void {
    const at = this.retained.indexOf(taskId);
    if (at >= 0) this.retained.splice(at, 1);
  }

  /** 句柄 LRU：超出上限时释放最久未用、空闲的子会话（JSONL 仍在，续聊时重开）。 */
  retain(taskId: string): void {
    this.touch(taskId);
    if (this.tasks.get(taskId)?.handle === undefined) return;
    this.retained.push(taskId);
    const limit = this.retainLimit() ?? DEFAULT_RETAINED;
    while (this.retained.length > limit) {
      const evicted = this.tasks.get(this.retained.shift() as string);
      const handle = evicted?.handle;
      if (evicted === undefined || handle === undefined) continue;
      delete evicted.handle;
      void (handle.dispose?.() ?? handle.stop()).catch(() => undefined);
    }
  }
}
