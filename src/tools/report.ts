/**
 * `report` 工具：子 Agent 向父会话报告结构化状态（#269，语义见 agents/report.ts）。
 *
 * - `task` 的伴随工具（registry.ts 的 `TOOL_COMPANIONS`）：父子会话的工具表里都有它，子会话的工具表才能与父
 *   逐字节一致（缓存前缀，D23）；父会话（depth 0）调用被拒并提示直接回答用户，子会话（depth ≥ 1）才记录。
 * - 工具本身不折叠：校验后把这一次调用放进 `details.report`，由 ama runner（session-subagent.ts）按运行折叠
 *   成 `SubagentResult.report`；工具结果文案固定英文。
 * - `humanAction` 的 schema 不写 `type`（子集不支持可空类型）：运行时接受字符串或 `null`。
 */

import { REPORT_STATES, REPORT_TEXT_MAX, isReportState } from "../agents/report.js";
import type { SubagentReportUpdate, ToolDefinition, ToolResult } from "./types.js";

export const REPORT_TOOL = "report";

/** 父会话里的拒绝文案（固定英文）。 */
export const REPORT_PARENT_REJECTION =
  "report is only available inside a sub-agent; you are talking to the user directly, so reply " +
  "to them instead.";

export interface ReportInput {
  state: string;
  summary: string;
  humanAction?: string | null;
}

function fail(message: string): ToolResult {
  return { content: message, isError: true };
}

/** 校验并归一化一次调用；出错返回文案。 */
export function parseReportInput(input: ReportInput): SubagentReportUpdate | string {
  if (!isReportState(input.state)) return `state must be one of ${REPORT_STATES.join(", ")}`;
  if (typeof input.summary !== "string" || input.summary.trim() === "")
    return "summary must be a non-empty string";
  const summary = input.summary.trim();
  if (summary.length > REPORT_TEXT_MAX)
    return `summary must be at most ${REPORT_TEXT_MAX} characters`;
  const update: SubagentReportUpdate = { state: input.state, summary };
  const action = input.humanAction;
  if (action === null) update.humanAction = null;
  else if (action !== undefined) {
    if (typeof action !== "string") return "humanAction must be a string or null";
    const text = action.trim();
    if (text.length > REPORT_TEXT_MAX)
      return `humanAction must be at most ${REPORT_TEXT_MAX} characters`;
    // 空串视同清空（模型常用 "" 表示「没有」）
    update.humanAction = text === "" ? null : text;
  }
  return update;
}

/** 工具结果（固定英文）：说明记下了什么。 */
export function reportRecordedText(update: SubagentReportUpdate): string {
  const head = `Recorded: ${update.state} — ${update.summary}`;
  if (update.humanAction === undefined) return head;
  if (update.humanAction === null) return `${head}\nHuman action cleared.`;
  return `${head}\nHuman action: ${update.humanAction}`;
}

export function createReportTool(): ToolDefinition<ReportInput> {
  return {
    name: REPORT_TOOL,
    label: "Report",
    description:
      "Sub-agents only: your state and a one-line summary for the main agent; humanAction: a " +
      "question only a person can answer (null clears it).",
    parameters: {
      type: "object",
      properties: {
        state: { type: "string", enum: [...REPORT_STATES] },
        summary: { type: "string" },
        humanAction: {},
      },
      required: ["state", "summary"],
      additionalProperties: false,
    },
    permission: "read",
    executionMode: "parallel",
    promptSnippet: "report: sub-agents report their state to the main agent",
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.depth < 1) return fail(REPORT_PARENT_REJECTION);
      const update = parseReportInput(input);
      if (typeof update === "string") return fail(update);
      return { content: reportRecordedText(update), details: { report: update } };
    },
  };
}
