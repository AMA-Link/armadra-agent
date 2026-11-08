/**
 * 子 Agent 结构化报告的折叠与文本（#269，agents/report.ts）。
 */

import { describe, expect, it } from "vitest";
import {
  HUMAN_ACTION_RULE,
  REPORT_STATES,
  foldReport,
  isReportState,
  reportLines,
  withReportLines,
} from "./report.js";

describe("foldReport：单槽三种语义", () => {
  it("给出替换、省略保持、null 清空；state / summary 总取最后一次", () => {
    const first = foldReport(undefined, {
      state: "blocked",
      summary: "need an account",
      humanAction: "Which test account should I use?",
    });
    expect(first).toEqual({
      state: "blocked",
      summary: "need an account",
      humanAction: "Which test account should I use?",
    });
    const kept = foldReport(first, { state: "waiting", summary: "waiting for the answer" });
    expect(kept).toEqual({
      state: "waiting",
      summary: "waiting for the answer",
      humanAction: "Which test account should I use?",
    });
    const replaced = foldReport(kept, {
      state: "blocked",
      summary: "two questions now",
      humanAction: "Also: staging or prod?",
    });
    expect(replaced.humanAction).toBe("Also: staging or prod?");
    const cleared = foldReport(replaced, { state: "ready", summary: "done", humanAction: null });
    expect(cleared).toEqual({ state: "ready", summary: "done" });
    expect("humanAction" in cleared).toBe(false);
  });

  it("没有前值时省略与 null 都得到没有 humanAction 的报告", () => {
    expect(foldReport(undefined, { state: "ready", summary: "ok" })).toEqual({
      state: "ready",
      summary: "ok",
    });
    expect(foldReport(undefined, { state: "ready", summary: "ok", humanAction: null })).toEqual({
      state: "ready",
      summary: "ok",
    });
  });

  it("isReportState 只认四个状态", () => {
    for (const state of REPORT_STATES) expect(isReportState(state)).toBe(true);
    expect(isReportState("done")).toBe(false);
    expect(isReportState(undefined)).toBe(false);
  });
});

describe("报告行（固定英文）", () => {
  it("只有状态与摘要时一行；有 humanAction 时加 [needs a person] 与规则句", () => {
    expect(reportLines({ state: "ready", summary: "All tests pass." })).toEqual([
      "[report] ready · All tests pass.",
    ]);
    expect(
      reportLines({ state: "blocked", summary: "Need an account.", humanAction: "Which one?" }),
    ).toEqual([
      "[report] blocked · Need an account.",
      "[needs a person] Which one?",
      HUMAN_ACTION_RULE,
    ]);
    expect(HUMAN_ACTION_RULE).toBe(
      "Relay this question to the user verbatim; do not answer it yourself.",
    );
  });

  it("withReportLines：有报告时报告行 + 空行 + 正文；没有报告时逐字节原样", () => {
    const body = "I changed two files.\n\nFiles changed:\n- a.ts";
    expect(withReportLines(body, undefined)).toBe(body);
    expect(withReportLines(body, { state: "ready", summary: "Done." })).toBe(
      `[report] ready · Done.\n\n${body}`,
    );
  });
});
