/**
 * [#313] `task_land`：把 worktree 子任务的提交落到当前分支。
 *
 * 会改父仓库，所以是独立的 `execute` 工具、走完整权限管线，不放进权限为 `read` 的 `task_ctl`。与 `task`
 * 同进退；子会话里运行时拒绝；`coordinator` 预设（协调者不写文件）下同样拒绝，工具表不变；不进 codemode
 * 的可调用清单（不增加 codemode 描述的长度，也不让脚本批量落地）。
 */

import type { LandResult } from "../agent/worktree-land.js";
import { taskControl } from "../agents/task-control.js";
import { nestedTaskRejection } from "./task.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";

export const TASK_LAND_TOOL = "task_land";

export interface TaskLandInput {
  taskId: string;
}

const refused = new WeakSet<object>();

/** 组装根在 `coordinator` 预设下调用：描述与 schema 不变，执行时拒绝。 */
export function refuseTaskLand(tool: ToolDefinition | undefined): void {
  if (tool !== undefined) refused.add(tool);
}

function fail(message: string): ToolResult {
  return { content: message, isError: true };
}

export function landText(taskId: string, result: LandResult): ToolResult {
  switch (result.status) {
    case "landed": {
      const head = `Landed task ${taskId}: ${result.commits.length} commit(s) on the current branch (${result.commits.map((c) => c.slice(0, 9)).join(", ")}).`;
      return {
        content:
          result.cleanupError === undefined
            ? `${head} Worktree removed.`
            : `${head} Worktree cleanup failed: ${result.cleanupError}`,
      };
    }
    case "nothing":
      return { content: `Task ${taskId} has no changes to land. Worktree removed.` };
    case "blocked": {
      const files = result.files === undefined ? "" : `\nConflicts: ${result.files.join(", ")}`;
      return fail(`Task ${taskId} not landed; its worktree is kept. ${result.reason}${files}`);
    }
  }
}

export function createTaskLandTool(): ToolDefinition<TaskLandInput> {
  const tool: ToolDefinition<TaskLandInput> = {
    name: TASK_LAND_TOOL,
    label: "TaskLand",
    description:
      "Land a finished worktree task's commits on the current branch; on conflict nothing changes.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
    promptSnippet: "task_land: land a worktree task on the current branch",
    permission: "execute",
    executionMode: "sequential",
    async execute(input, ctx: ToolContext): Promise<ToolResult> {
      if (ctx.depth >= 1)
        return fail(
          nestedTaskRejection(
            ctx,
            TASK_LAND_TOOL,
            "task_land is not available inside a sub-agent.",
          ),
        );
      if (refused.has(tool)) return fail("task_land is not available to a coordinator.");
      const control = taskControl(ctx.sessionId);
      if (control?.land === undefined || control.get(input.taskId) === undefined)
        return fail(`Unknown task ${input.taskId}.`);
      return landText(input.taskId, await control.land(input.taskId));
    },
  };
  return tool;
}
