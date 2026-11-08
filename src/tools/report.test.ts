/**
 * `report` 工具（#269）：父会话被拒、子会话校验与 `details.report`。折叠语义在 agents/report.test.ts，
 * 端到端（子会话 → 父结果）在 agent/session-subagent-report.test.ts。
 */

import { describe, expect, it } from "vitest";
import { makeToolContext } from "../../test/helpers/tool-context.js";
import { REPORT_TEXT_MAX } from "../agents/report.js";
import { REPORT_PARENT_REJECTION, createReportTool, parseReportInput } from "./report.js";

const tool = createReportTool();
const child = () => makeToolContext("/w", { depth: 1 });

describe("report 工具", () => {
  it("父会话（depth 0）调用被拒，文案固定英文", async () => {
    const r = await tool.execute({ state: "ready", summary: "done" }, makeToolContext("/w"));
    expect(r).toEqual({ content: REPORT_PARENT_REJECTION, isError: true });
    expect(REPORT_PARENT_REJECTION).toContain("only available inside a sub-agent");
  });

  it("子会话：记下这次调用（details.report），结果说明记了什么；不写 custom 条目", async () => {
    const ctx = child();
    const r = await tool.execute(
      { state: "blocked", summary: "  Need an account. ", humanAction: "Which account?" },
      ctx,
    );
    expect(r).toEqual({
      content: "Recorded: blocked — Need an account.\nHuman action: Which account?",
      details: {
        report: { state: "blocked", summary: "Need an account.", humanAction: "Which account?" },
      },
    });
    expect(ctx.customs).toEqual([]);
  });

  it("humanAction：省略不出现在 details；null 与空串都是清空", async () => {
    const omitted = await tool.execute({ state: "ready", summary: "ok" }, child());
    expect(omitted.details).toEqual({ report: { state: "ready", summary: "ok" } });
    expect(omitted.content).toBe("Recorded: ready — ok");
    const cleared = await tool.execute(
      { state: "ready", summary: "ok", humanAction: null },
      child(),
    );
    expect(cleared.details).toEqual({
      report: { state: "ready", summary: "ok", humanAction: null },
    });
    expect(cleared.content).toBe("Recorded: ready — ok\nHuman action cleared.");
    const blank = await tool.execute({ state: "ready", summary: "ok", humanAction: "  " }, child());
    expect(blank.details).toEqual({ report: { state: "ready", summary: "ok", humanAction: null } });
  });

  it("校验：状态枚举、摘要非空且 ≤ 300、humanAction 为字符串或 null 且 ≤ 300", async () => {
    const long = "x".repeat(REPORT_TEXT_MAX + 1);
    expect(parseReportInput({ state: "done", summary: "ok" })).toBe(
      "state must be one of ready, blocked, failed, waiting",
    );
    expect(parseReportInput({ state: "ready", summary: " " })).toBe(
      "summary must be a non-empty string",
    );
    expect(parseReportInput({ state: "ready", summary: long })).toBe(
      `summary must be at most ${REPORT_TEXT_MAX} characters`,
    );
    expect(parseReportInput({ state: "ready", summary: "ok", humanAction: long })).toBe(
      `humanAction must be at most ${REPORT_TEXT_MAX} characters`,
    );
    expect(
      parseReportInput({ state: "ready", summary: "ok", humanAction: 1 as unknown as string }),
    ).toBe("humanAction must be a string or null");
    const r = await tool.execute({ state: "nope", summary: "ok" }, child());
    expect(r).toMatchObject({ isError: true });
  });

  it("schema：state 枚举、summary 必填、humanAction 不写 type（子集不支持可空类型）", () => {
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        state: { type: "string", enum: ["ready", "blocked", "failed", "waiting"] },
        summary: { type: "string" },
        humanAction: {},
      },
      required: ["state", "summary"],
      additionalProperties: false,
    });
    expect(tool.permission).toBe("read");
    expect(tool.promptSnippet).toContain("report:");
  });
});
