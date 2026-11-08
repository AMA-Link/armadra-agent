import { describe, expect, it } from "vitest";
import type { SubagentReport } from "../tools/types.js";
import { TurnCollector, reportFromTurn } from "./turn.js";
import type { DriverEvent, DriverTurnResult } from "./types.js";

const call = (
  status: "pending" | "in_progress" | "completed" | "failed",
  title = "Write a.txt",
): DriverEvent => ({
  type: "tool_call",
  id: "t1",
  title,
  kind: "edit",
  status,
  locations: ["/w/a.txt"],
});

describe("TurnCollector 的工具进度去重", () => {
  it("审批前后回到已报过的状态（pending → in_progress → pending → in_progress）不重复转发", () => {
    const seen: DriverEvent[] = [];
    const turn = new TurnCollector((e) => seen.push(e));
    for (const status of ["pending", "in_progress", "pending", "in_progress", "completed"] as const)
      turn.push(call(status));
    expect(seen.map((e) => (e.type === "tool_call" ? e.status : e.type))).toEqual([
      "pending",
      "in_progress",
      "completed",
    ]);
    expect(turn.result("end_turn")).toMatchObject({
      filesTouched: ["/w/a.txt"],
      toolSummary: ["✓ edit Write a.txt"],
    });
  });

  it("同一状态但标题或位置变了照常转发；不同 id 互不影响", () => {
    const seen: DriverEvent[] = [];
    const turn = new TurnCollector((e) => seen.push(e));
    turn.push(call("in_progress"));
    turn.push(call("in_progress"));
    turn.push(call("in_progress", "Write b.txt"));
    turn.push({ ...call("in_progress"), id: "t2" } as DriverEvent);
    expect(seen.map((e) => (e.type === "tool_call" ? `${e.id} ${e.title}` : e.type))).toEqual([
      "t1 Write a.txt",
      "t1 Write b.txt",
      "t2 Write a.txt",
    ]);
  });
});

describe("[#269] reportFromTurn：外部 Agent 的结构化报告映射", () => {
  const turn = (stopReason: DriverTurnResult["stopReason"], report?: SubagentReport) => ({
    stopReason,
    ...(report === undefined ? {} : { report }),
  });

  it("驱动给的 report 优先；否则 refusal → failed、max_tokens / max_turn_requests → blocked", () => {
    const own: SubagentReport = { state: "waiting", summary: "asked the user" };
    expect(reportFromTurn("codex", turn("end_turn", own), false)).toBe(own);
    expect(reportFromTurn("codex", turn("refusal"), false)).toEqual({
      state: "failed",
      summary: "codex refused the request.",
    });
    expect(reportFromTurn("codex", turn("max_tokens"), false)).toEqual({
      state: "blocked",
      summary: "codex hit its output limit before finishing.",
    });
    expect(reportFromTurn("codex", turn("max_turn_requests"), false)).toEqual({
      state: "blocked",
      summary: "codex hit its turn limit before finishing.",
    });
  });

  it("end_turn / cancelled 不编造；超时时即使驱动给了也不带（status 已表达）", () => {
    expect(reportFromTurn("codex", turn("end_turn"), false)).toBeUndefined();
    expect(reportFromTurn("codex", turn("cancelled"), false)).toBeUndefined();
    expect(
      reportFromTurn("codex", turn("end_turn", { state: "ready", summary: "ok" }), true),
    ).toBeUndefined();
  });
});
