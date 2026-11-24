/**
 * 任务记录收尾（从 subagent-registry.ts 拆出，保持 ≤ 600 行）：终态、worktree 收尾、结果截断与落盘、
 * 本次运行花费记到祖先会话、级联取消后代、`subagent_end`。[W5-G / #317]
 */

import type { SubagentResult, SubagentStatus } from "../tools/types.js";
import { capTaskText, decorateTaskText, writeTaskOutput } from "../agents/result.js";
import {
  TERMINAL_STATUSES,
  flushText,
  type ProgressSink,
  type TaskRecord,
} from "../agents/task-record.js";
import type { RegistryHost } from "./subagent-registry.js";
import type { SubagentStore } from "./subagent-store.js";
import { cascadeAbort, chargeAncestors, ownSpent } from "./subagent-nest.js";
import { finishWorktree } from "./worktree.js";

export interface FinishContext {
  host: RegistryHost;
  store: SubagentStore;
  tasks: ReadonlyMap<string, TaskRecord>;
  now(): number;
  sink: ProgressSink;
}

export async function finishRecord(
  ctx: FinishContext,
  record: TaskRecord,
  result: SubagentResult,
  aborted: boolean,
): Promise<SubagentResult> {
  flushText(record, ctx.sink);
  const status: SubagentStatus = aborted
    ? "aborted"
    : result.status !== undefined && TERMINAL_STATUSES.includes(result.status as SubagentStatus)
      ? (result.status as SubagentStatus)
      : result.isError
        ? "failed"
        : "completed";
  if (record.worktree !== undefined) {
    try {
      record.worktreeOutcome = await finishWorktree(record.worktree);
      if (!record.worktreeOutcome.changed) delete record.worktree;
    } catch (error) {
      ctx.host.log("warn", `worktree cleanup failed: ${String(error)}`);
    }
  }
  const info = record.info;
  info.status = status;
  info.endedAt = ctx.now();
  if (result.usage.totalTokens > 0 || info.usage === undefined) info.usage = result.usage;
  record.text = result.text;
  let outputFile: string | undefined;
  const full = result.text;
  const capped = capTaskText(full, ctx.store.outputFileFor(info.taskId));
  if (capped.truncated || info.background) {
    outputFile = writeTaskOutput(
      ctx.store.outputDirectory(),
      ctx.store.outputName(info.taskId),
      full,
    );
    if (outputFile !== undefined) info.outputFile = outputFile;
  }
  // [#269] 结构化报告：runner 给的为准（这次运行折叠后的值）；没有就清掉运行中记下的
  const report = result.report;
  if (report === undefined) delete info.report;
  else info.report = report;
  const outcome = record.worktreeOutcome;
  const final: SubagentResult = {
    ...result,
    text: decorateTaskText(capped.text, status, report, outcome),
    taskId: info.taskId,
    status,
    isError: status === "failed" || status === "aborted",
  };
  if (outputFile !== undefined) final.outputFile = outputFile;
  if (info.sessionRef !== undefined) final.sessionRef = info.sessionRef;
  if (report !== undefined) final.report = report;
  record.last = final;
  const own = ownSpent(record);
  chargeAncestors(ctx.tasks, record, own); // [#317] 花费逐级记到祖先会话
  cascadeAbort(ctx.tasks, info.taskId);
  ctx.store.persist(record);
  const end: Extract<Parameters<RegistryHost["emit"]>[0], { type: "subagent_end" }> = {
    type: "subagent_end",
    taskId: info.taskId,
    status,
  };
  if (info.usage !== undefined) end.usage = info.usage;
  if (result.cache !== undefined) end.cache = result.cache;
  if (outputFile !== undefined) end.outputFile = outputFile;
  if (outcome !== undefined) end.worktree = { branch: outcome.branch, changed: outcome.changed };
  if (report !== undefined) end.report = report;
  if (info.costUsd !== undefined) end.costUsd = own;
  if (info.parentTaskId !== undefined) end.parentTaskId = info.parentTaskId;
  if (info.depth !== undefined) end.depth = info.depth;
  ctx.host.emit(end);
  ctx.store.retain(info.taskId);
  return final;
}
