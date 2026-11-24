import { describe, expect, it } from "vitest";
import type { TaskInfo } from "../tools/types.js";
import { workflowFromTasks } from "./from-tasks.js";
import { validateWorkflow } from "./validate.js";

function task(
  id: string,
  start: number,
  end: number | undefined,
  extra: Partial<TaskInfo> = {},
): TaskInfo {
  return {
    taskId: id,
    agent: "general",
    runner: "ama",
    description: `desc ${id}`,
    background: false,
    status: "completed",
    startedAt: start,
    ...(end !== undefined ? { endedAt: end } : {}),
    ...extra,
  };
}

describe("workflowFromTasks", () => {
  it("没有深度 1 的任务 → undefined", () => {
    expect(workflowFromTasks([], new Map(), "t")).toBeUndefined();
    expect(
      workflowFromTasks([task("x", 1, 2, { depth: 2, parentTaskId: "p" })], new Map(), "t"),
    ).toBeUndefined();
  });

  it("角色与步骤：ama / 外部 / 只读类型 / 档位 / 丢失的类型名", () => {
    const wf = workflowFromTasks(
      [
        task("t1", 1, 2, { agent: "explore", tier: "light" }),
        task("t2", 3, 4, { agent: "reviewer" }),
        task("t3", 5, 6, { agent: "claude", runner: "claude" }),
        task("deep", 5, 6, { depth: 2, parentTaskId: "t1" }),
      ],
      new Map([["t1", "look around"]]),
      "My flow",
    )!;
    expect(wf.title).toBe("My flow");
    expect(wf.roles).toEqual([
      { id: "role1", agentId: "ama", title: "desc t1", permissionMode: "plan", tier: "light" },
      { id: "role2", agentId: "ama", title: "desc t2" },
      { id: "role3", agentId: "claude", title: "desc t3" },
    ]);
    expect(wf.steps.map((s) => (s.kind === "prompt" ? s.prompt : ""))).toEqual([
      "look around",
      "desc t2",
      "desc t3",
    ]);
    expect(wf.description).toContain("role2: reviewer");
    expect(validateWorkflow(wf).ok).toBe(true);
  });

  it("依赖：endedAt ≤ startedAt，传递约简；并发任务互不依赖；未结束的不是依赖", () => {
    const wf = workflowFromTasks(
      [
        task("a", 0, 10),
        task("b", 10, 20), // 依赖 a
        task("c", 10, 25), // 依赖 a，与 b 并发
        task("d", 30, 40), // 依赖 a b c → 约简为 b c
        task("e", 31, undefined), // 依赖 a b c d(未到 end 31? d.end=40>31 否) → b c
      ],
      new Map(),
      "t",
    )!;
    const after = Object.fromEntries(
      wf.steps.map((s) => [s.id, "after" in s ? (s.after ?? []) : []]),
    );
    expect(after).toEqual({
      step1: [],
      step2: ["step1"],
      step3: ["step1"],
      step4: ["step2", "step3"],
      step5: ["step2", "step3"],
    });
    expect(validateWorkflow(wf).ok).toBe(true);
  });

  it("零时长任务同时刻不成环（按启动序只依赖前面的）", () => {
    const wf = workflowFromTasks([task("a", 5, 5), task("b", 5, 5)], new Map(), "t")!;
    expect(wf.steps.map((s) => ("after" in s ? (s.after ?? []) : []))).toEqual([[], ["step1"]]);
    expect(validateWorkflow(wf).ok).toBe(true);
  });
});
