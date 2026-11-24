/**
 * ama 子会话一次运行的收尾（从 session-subagent.ts 拆出，保持 ≤ 600 行）：把子会话统计与最后一条
 * 助手消息收成 `SubagentResult`，缓存命中与重计费按增量汇总进父。
 */

import type { SubagentResult } from "../tools/types.js";
import type { ChildSession, SubagentParent } from "./session-subagent.js";
import type { SessionStats } from "./types.js";

export function collect(
  child: ChildSession,
  error: string | undefined,
  exhausted: boolean,
  aborted: boolean,
): SubagentResult {
  const stats = child.getStats();
  const last = child.manager
    .branch()
    .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
  const stopReason =
    error !== undefined
      ? "error"
      : last?.type === "message" && last.message.role === "assistant"
        ? last.message.stopReason
        : "stop";
  const isError = error !== undefined || stopReason === "error" || stopReason === "aborted";
  const result: SubagentResult = {
    text: child.getLastAssistantText() ?? error ?? "",
    usage: {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      totalTokens: stats.tokens.total,
    },
    stopReason,
    isError,
    status:
      aborted || stopReason === "aborted"
        ? "aborted"
        : isError
          ? "failed"
          : exhausted
            ? "max_turns"
            : "completed",
  };
  if (stats.cache !== undefined) {
    result.cache = { reBilledTokens: stats.cache.reBilledTokens };
    if (stats.cache.hitRate !== undefined) result.cache.hitRate = stats.cache.hitRate;
  }
  return result;
}

/** 子会话命中与重计费按增量汇总进父（续聊不重复计）。 */
export function addCache(
  parent: SubagentParent,
  stats: SessionStats,
  before: { cacheRead: number; prompt: number; reBilled: number },
): { cacheRead: number; prompt: number; reBilled: number } {
  const cache = stats.cache;
  if (cache === undefined) return before;
  // 不报缓存的子会话不进命中率分母（同父会话口径）
  const reported = cache.reporting === "reported";
  const { input, cacheRead, cacheWrite } = stats.tokens;
  const now = reported
    ? { cacheRead, prompt: input + cacheRead + cacheWrite, reBilled: cache.reBilledTokens }
    : { cacheRead: 0, prompt: 0, reBilled: cache.reBilledTokens };
  parent.cache?.addSubagent(
    { cacheRead: now.cacheRead - before.cacheRead, prompt: now.prompt - before.prompt },
    now.reBilled - before.reBilled,
  );
  return now;
}
