/**
 * 异常结束的判定（#268）：只看会话文件的活动分支，不需要新的持久化。
 *
 * 记 A = 分支上最后一条 assistant 消息，T = A 之后的条目。下面任一成立即「上一轮没有正常结束」：
 * - R1 悬空调用：A 有 toolCall 块而 T 里缺对应的 toolResult（正常运行下错误 / 中断路径都由
 *   `closeDanglingCalls` 补齐，只有工具执行中进程被杀才会缺）；
 * - R2 非人为中断：A 的 stopReason 是 `aborted` 而 T 里没有 `custom_message{ama.aborted}`（人按 Esc、
 *   `interrupt: true`、RPC abort、SIGINT 都会在 abort 之后落这一条）；
 * - R3 回合没结束：本会话在写 `ama.trace`（A 之前有 step），而 A 之后没有 step（`turn_end` 时才写，
 *   toolResult 之后；结果已落、finishTurn 期间被杀就落在这里）。
 *
 * 明确不判：最后一条是 user（本回合还没有任何工具动作）；最后一条是 toolResult 且其后有 step（既可能
 * 是下一次请求中被杀，也可能是 terminate / 重复调用检测 / Hook 停止 / 预算到限的正常停止，文件里分不出，
 * 而且结果都在上下文里）；`error` / `length`；有 `ama.aborted` 的中断。
 *
 * 「只提醒一次」靠已落盘的提醒本身：注入的 `custom_message{ama.reminder}` 带 `details.recovery = true`，
 * T 里已有它就 `reminded: true`。
 *
 * 本模块不 import agent/（依赖方向 agent → session），自定义类型名字面量与 agent 侧常量一致（测试守住）。
 */

import type { AssistantMessage } from "../ai/types.js";
import type { SessionEntry } from "./types.js";

/** 与 `agent/session-run.ts` 的 `ABORTED_CUSTOM_TYPE` 相同。 */
export const UNCLEAN_ABORTED_TYPE = "ama.aborted";
/** 与 `agent/reminders.ts` 的 `REMINDER_CUSTOM_TYPE` 相同。 */
export const UNCLEAN_REMINDER_TYPE = "ama.reminder";
/** 与 `trace/types.ts` 的 `TRACE_CUSTOM_TYPE` 相同。 */
export const UNCLEAN_TRACE_TYPE = "ama.trace";

/** 工具清单的上限：条数与单项长度。 */
export const UNCLEAN_TOOLS_MAX = 12;
export const UNCLEAN_TARGET_MAX = 80;

export type UncleanEndReason =
  "dangling_tool_calls" | "aborted_without_interrupt" | "turn_not_ended";

export interface UncleanEnd {
  reason: UncleanEndReason;
  /** 上一轮调用过的工具（`name` 或 `name target`，缺结果的带 ` (no result)`），去重、已封顶。 */
  tools: string[];
  /** 封顶后没列出的条数。 */
  more: number;
  /** T 里已有恢复提醒（第二次 resume 不再注入）。 */
  reminded: boolean;
}

function lastAssistantIndex(branch: readonly SessionEntry[]): number {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message.role === "assistant") return i;
  }
  return -1;
}

function isTraceStep(entry: SessionEntry): boolean {
  return (
    entry.type === "custom" &&
    entry.customType === UNCLEAN_TRACE_TYPE &&
    typeof entry.data === "object" &&
    entry.data !== null &&
    (entry.data as { kind?: unknown }).kind === "step"
  );
}

function isRecoveryReminder(entry: SessionEntry): boolean {
  return (
    entry.type === "custom_message" &&
    entry.customType === UNCLEAN_REMINDER_TYPE &&
    typeof entry.details === "object" &&
    entry.details !== null &&
    (entry.details as { recovery?: unknown }).recovery === true
  );
}

function resultIds(entries: readonly SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries)
    if (entry.type === "message" && entry.message.role === "toolResult")
      ids.add(entry.message.toolCallId);
  return ids;
}

function reasonOf(
  branch: readonly SessionEntry[],
  at: number,
  assistant: AssistantMessage,
  after: readonly SessionEntry[],
): UncleanEndReason | undefined {
  const calls = assistant.content.filter((block) => block.type === "toolCall");
  if (calls.length > 0) {
    const results = resultIds(after);
    if (calls.some((call) => !results.has(call.id))) return "dangling_tool_calls";
  }
  if (assistant.stopReason === "aborted") {
    const interrupted = after.some(
      (entry) => entry.type === "custom_message" && entry.customType === UNCLEAN_ABORTED_TYPE,
    );
    if (!interrupted) return "aborted_without_interrupt";
  }
  const tracing = branch.slice(0, at).some(isTraceStep);
  if (tracing && !after.some(isTraceStep)) return "turn_not_ended";
  return undefined;
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > UNCLEAN_TARGET_MAX ? `${one.slice(0, UNCLEAN_TARGET_MAX - 1)}…` : one;
}

/** 命令开头的环境变量赋值（`API_KEY=… cmd`）：值可能是密钥，一个字都不带出去。 */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * 工具调用的目标：bash 取命令第一个词（跳过开头的 `VAR=…` 赋值；剩下的词仍带 `=` 或以 `-` 开头时不带
 * 目标），write / edit 取路径（去掉 `?` / `#` 之后的部分，查询串里可能有令牌），其余不带目标；从不读结果正文。
 */
export function toolTarget(name: string, args: Record<string, unknown>): string | undefined {
  if (name === "bash") {
    const command = args["command"];
    if (typeof command !== "string") return undefined;
    const words = command.trim().split(/\s+/);
    const first = words.find((word) => !ENV_ASSIGNMENT.test(word));
    if (first === undefined || first === "" || first.includes("=") || first.startsWith("-")) {
      return undefined;
    }
    return clip(first);
  }
  if (name === "write" || name === "edit") {
    const path = args["path"];
    if (typeof path !== "string") return undefined;
    const bare = path.split(/[?#]/, 1)[0] ?? "";
    return bare !== "" ? clip(bare) : undefined;
  }
  return undefined;
}

/** 上一轮 = 最后一条非 steer 的 user 消息之后；列出其中全部 assistant 的工具调用。 */
function lastTurnTools(
  branch: readonly SessionEntry[],
  results: ReadonlySet<string>,
): { tools: string[]; more: number } {
  let start = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (
      entry?.type === "message" &&
      entry.message.role === "user" &&
      entry.message.origin !== "steer"
    ) {
      start = i + 1;
      break;
    }
  }
  const seen = new Set<string>();
  const tools: string[] = [];
  for (const entry of branch.slice(start)) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type !== "toolCall") continue;
      const target = toolTarget(block.name, block.arguments);
      const head = target === undefined ? block.name : `${block.name} ${target}`;
      const line = results.has(block.id) ? head : `${head} (no result)`;
      if (seen.has(line)) continue;
      seen.add(line);
      tools.push(line);
    }
  }
  const shown = tools.slice(0, UNCLEAN_TOOLS_MAX);
  return { tools: shown, more: tools.length - shown.length };
}

/** 活动分支上一轮是否异常结束；干净（或没有 assistant）返回 undefined。 */
export function detectUncleanEnd(branch: readonly SessionEntry[]): UncleanEnd | undefined {
  const at = lastAssistantIndex(branch);
  if (at < 0) return undefined;
  const entry = branch[at];
  if (entry?.type !== "message" || entry.message.role !== "assistant") return undefined;
  const after = branch.slice(at + 1);
  const reason = reasonOf(branch, at, entry.message, after);
  if (reason === undefined) return undefined;
  const { tools, more } = lastTurnTools(branch, resultIds(branch));
  return { reason, tools, more, reminded: after.some(isRecoveryReminder) };
}
