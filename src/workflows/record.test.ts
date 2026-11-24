import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../session/types.js";
import { interruptedRecordOf, rebuildWorkflowRuns, runRecordOf } from "./record.js";
import type { WorkflowRunRecord } from "./run-types.js";
import type { WorkflowRunState } from "./record.js";

function state(): WorkflowRunState {
  return {
    runId: "r1",
    workflowId: "w",
    title: "T",
    source: { scope: "project", filePath: "/p/w.md", hash: "h" },
    params: { a: "1" },
    status: "running",
    steps: [{ id: "s1", kind: "prompt", status: "running", warnings: ["x"] }],
    startedAt: 10,
  };
}
function rec(runId: string, status: WorkflowRunRecord["status"], extra = {}): WorkflowRunRecord {
  return { ...runRecordOf({ ...state(), runId, status }), ...extra };
}
let n = 0;
function entry(data: unknown, customType = "ama.workflow"): SessionEntry {
  return {
    type: "custom",
    customType,
    data,
    id: `e${++n}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
  } as SessionEntry;
}

describe("runRecordOf", () => {
  it("copies the state without sharing references", () => {
    const s = state();
    const r = runRecordOf(s);
    expect(r).toEqual(s);
    s.steps[0]!.status = "done";
    s.steps[0]!.warnings!.push("y");
    s.params.a = "2";
    expect(r.steps[0]!.status).toBe("running");
    expect(r.steps[0]!.warnings).toEqual(["x"]);
    expect(r.params.a).toBe("1");
  });
  it("only writes optional fields that are set", () => {
    const r = runRecordOf(state());
    expect(r).not.toHaveProperty("endedAt");
    expect(r).not.toHaveProperty("error");
    expect(r).not.toHaveProperty("host");
  });
});

describe("rebuildWorkflowRuns", () => {
  it("returns runs whose last snapshot is unfinished", () => {
    const entries = [
      entry(rec("a", "running")),
      entry(rec("b", "running")),
      entry(rec("b", "succeeded")),
      entry(rec("c", "waiting")),
      entry(rec("a", "running", { startedAt: 99 })),
    ];
    const runs = rebuildWorkflowRuns(entries);
    expect(runs.map((r) => r.runId)).toEqual(["a", "c"]);
    expect(runs[0]!.startedAt).toBe(99);
  });
  it("ignores other entries, malformed data and host runs", () => {
    const entries = [
      entry(rec("x", "running"), "other"),
      entry({ nope: 1 }),
      entry(null),
      entry(rec("h", "running", { host: { runId: "hr" } })),
      entry(rec("u", "waiting", { error: { code: "workflow_unsupported", message: "m" } })),
      { ...entry("x"), type: "label" } as unknown as SessionEntry,
    ];
    expect(rebuildWorkflowRuns(entries)).toEqual([]);
  });
});

describe("interruptedRecordOf", () => {
  it("fails the run and cancels unfinished steps", () => {
    const base = rec("a", "running", {
      steps: [
        { id: "d", kind: "prompt", status: "done" },
        { id: "r", kind: "prompt", status: "running", phase: "running" },
        { id: "p", kind: "prompt", status: "pending" },
      ],
    });
    const out = interruptedRecordOf(base, 500);
    expect(out.status).toBe("failed");
    expect(out.endedAt).toBe(500);
    expect(out.error).toEqual({
      code: "interrupted",
      message: "The run was interrupted when the session ended.",
    });
    expect(out.steps.map((s) => s.status)).toEqual(["done", "cancelled", "cancelled"]);
    expect(out.steps[1]).not.toHaveProperty("phase");
  });
});
