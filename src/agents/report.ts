/**
 * 子 Agent 的结构化报告（#269）：`report` 工具的折叠语义与父会话看到的固定英文文本。
 *
 * - 报告槽按「一次运行」（一次 `task` 调用或一次 `taskId` 续聊）划定：运行开始清空，运行内每次 `report`
 *   调用折叠进去——`state` / `summary` 取最后一次，`humanAction` 是单槽：给出替换、省略保持、`null` 清空；
 *   运行结束取折叠后的值（session-subagent.ts 的 ama runner、drivers/runner.ts 的外部映射）。
 * - 父会话的 `task` 结果、`<task-notification>` 与 `task_ctl wait` 都在正文前加 `[report] state · summary`；
 *   有 `humanAction` 时再加 `[needs a person] …` 与固定规则句（注册表 `finish()` 统一拼，subagent-registry.ts）。
 * - 发给模型的文本全部固定英文；没有报告时所有文本与原来逐字节相同。
 */

import type { SubagentReport, SubagentReportState, SubagentReportUpdate } from "../tools/types.js";

export const REPORT_STATES: readonly SubagentReportState[] = [
  "ready",
  "blocked",
  "failed",
  "waiting",
];

/** `summary` 与 `humanAction` 的上限（字符）。 */
export const REPORT_TEXT_MAX = 300;

/** 父会话工具结果里跟在 `[needs a person]` 之后的规则句。 */
export const HUMAN_ACTION_RULE =
  "Relay this question to the user verbatim; do not answer it yourself.";

/** 子会话角色说明（`SUBAGENT_ROLE_PREAMBLE`、fork 的 `<task>`）末尾的一句。 */
export const REPORT_ROLE_HINT =
  "Before your final reply, call report with your state (ready, blocked, failed or waiting); put " +
  "anything only a person can decide in humanAction instead of assuming an answer.";

export function isReportState(value: unknown): value is SubagentReportState {
  return typeof value === "string" && (REPORT_STATES as readonly string[]).includes(value);
}

/** 单槽折叠：`state` / `summary` 取本次；`humanAction` 给出替换、省略保持、`null` 清空。 */
export function foldReport(
  previous: SubagentReport | undefined,
  update: SubagentReportUpdate,
): SubagentReport {
  const report: SubagentReport = { state: update.state, summary: update.summary };
  const action =
    update.humanAction === undefined
      ? previous?.humanAction
      : update.humanAction === null
        ? undefined
        : update.humanAction;
  if (action !== undefined && action !== "") report.humanAction = action;
  return report;
}

/** 正文前的报告行（固定英文）。 */
export function reportLines(report: SubagentReport): string[] {
  const lines = [`[report] ${report.state} · ${report.summary}`];
  if (report.humanAction !== undefined)
    lines.push(`[needs a person] ${report.humanAction}`, HUMAN_ACTION_RULE);
  return lines;
}

/** 报告行 + 空行 + 正文；没有报告时原样返回。 */
export function withReportLines(text: string, report: SubagentReport | undefined): string {
  if (report === undefined) return text;
  return `${reportLines(report).join("\n")}\n\n${text}`;
}
