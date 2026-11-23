/** [#313] 注册表的 `land()`：任务状态检查与落地后的记录更新（落地本身在 worktree-land.ts）。 */

import type { TaskRecord } from "../agents/task-record.js";
import { landWorktree, type LandResult } from "./worktree-land.js";

export async function landTask(
  record: TaskRecord | undefined,
  persist: (record: TaskRecord) => void,
): Promise<LandResult> {
  if (record === undefined) return { status: "blocked", reason: "unknown task" };
  if (record.running !== undefined)
    return { status: "blocked", reason: "the task is still running" };
  const tree = record.worktree;
  if (tree === undefined)
    return {
      status: "blocked",
      reason:
        "this session holds no kept worktree for the task (it had no changes, or the session was resumed; use git on its branch)",
    };
  const description = record.info.description.trim().split("\n")[0] ?? "";
  const message = `task ${record.info.taskId}: ${description === "" ? record.info.agent : description}`;
  const result = await landWorktree(tree, message);
  if (result.status !== "blocked") {
    delete record.worktree;
    delete record.worktreeOutcome;
    persist(record);
  }
  return result;
}
