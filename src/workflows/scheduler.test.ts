import { describe, expect, it } from "vitest";
import type { SubagentRequest, SubagentResult, TaskInfo } from "../tools/types.js";
import type { WorkflowHost, WorkflowRunRecord, WorkflowUpdate } from "./run-types.js";
import { runStandalone } from "./scheduler.js";
import type { WorkflowDocument, WorkflowRole, WorkflowStep } from "./types.js";

type Reply = Partial<SubagentResult> & { throws?: Error };
type Script = (req: SubagentRequest, taskId: string, n: number) => Reply | Promise<Reply>;
type Listener = Parameters<WorkflowHost["onTaskEvent"]>[0];

let sessionCounter = 0;
function fakeHost(script: Script = () => ({}), available: (n: string) => boolean = () => true) {
  const calls: SubagentRequest[] = [];
  const records: WorkflowRunRecord[] = [];
  const emitted: WorkflowUpdate[] = [];
  const logs: string[] = [];
  const tasks: TaskInfo[] = [];
  const listeners: Listener[] = [];
  let ids = 0;
  const host: WorkflowHost = {
    sessionId: `s${++sessionCounter}`,
    cwd: "/w",
    async spawn(req) {
      calls.push(req);
      const taskId = req.taskId ?? `t${++ids}`;
      const reply = await script(req, taskId, calls.length);
      if (reply.throws !== undefined) throw reply.throws;
      return {
        text: `out:${req.workflow?.stepId}`,
        usage: {} as never,
        stopReason: "end_turn",
        isError: false,
        taskId,
        status: "completed",
        ...reply,
      };
    },
    async wait() {
      throw new Error("unexpected wait");
    },
    tasks: () => tasks,
    onTaskEvent(l) {
      listeners.push(l);
      return () => listeners.splice(listeners.indexOf(l), 1);
    },
    agentAvailable: available,
    emit: (u) => emitted.push(u),
    record: (r) => records.push(r),
    log: (_l, m) => logs.push(m),
  };
  return { host, calls, records, emitted, logs, tasks, listeners };
}

const roles = (...ids: string[]): WorkflowRole[] => ids.map((id) => ({ id, agentId: "ama" }));
const p = (id: string, role: string, after: string[] = [], prompt = `do ${id}`): WorkflowStep => ({
  id,
  kind: "prompt",
  role,
  prompt,
  after,
});
function doc(steps: WorkflowStep[], extra: Partial<WorkflowDocument> = {}): WorkflowDocument {
  const ids = [...new Set(steps.flatMap((s) => (s.kind === "gate" ? [] : [s.role])))];
  return { version: 2, title: "T", roles: roles(...ids), steps, ...extra };
}
const ready = (summary = "ok") => ({ report: { state: "ready" as const, summary } });
const failedReport = (summary: string) => ({ report: { state: "failed" as const, summary } });
const stepOf = (u: SubagentRequest): string => u.workflow!.stepId;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("dependencies and parallelism", () => {
  it("runs independent roles concurrently and waits for after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeHost(async (req) => {
      if (stepOf(req) !== "s3") await gate;
      return {};
    });
    const run = runStandalone(
      f.host,
      { workflow: doc([p("s1", "a"), p("s2", "b"), p("s3", "c", ["s1", "s2"])]) },
      {},
    );
    await tick();
    expect(f.calls.map(stepOf)).toEqual(["s1", "s2"]);
    release();
    const result = await run.wait();
    expect(f.calls.map(stepOf)).toEqual(["s1", "s2", "s3"]);
    expect(result.status).toBe("succeeded");
    expect(result.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(f.calls[0]!.parentToolCallId).toBe(`workflow:${run.runId}:s1`);
    expect(f.calls[0]!.workflow).toMatchObject({ workflowId: "inline", roleId: "a" });
    expect(f.calls[0]!.background).toBe(false);
    expect(f.calls[0]!.description).toBe("inline/s1");
  });

  it("serializes steps of one role and continues the same task", async () => {
    const f = fakeHost();
    const run = runStandalone(f.host, { workflow: doc([p("s1", "a"), p("s2", "a")]) }, {});
    await run.wait();
    expect(f.calls[0]!.taskId).toBeUndefined();
    expect(f.calls[0]!.agent).toBe("general");
    expect(f.calls[1]!.taskId).toBe("t1");
    expect(f.calls[1]!.agent).toBeUndefined();
    expect(f.calls[1]!.prompt).toBe("do s2");
  });

  it("only outputs sink steps in declared order", async () => {
    const f = fakeHost();
    const w = doc([p("s1", "a"), p("s2", "b", ["s1"]), p("s3", "c", ["s1"]), p("g", "a")]);
    const result = await runStandalone(f.host, { workflow: w }, {}).wait();
    expect(result.outputs).toEqual([
      { stepId: "s2", text: "out:s2" },
      { stepId: "s3", text: "out:s3" },
      { stepId: "g", text: "out:g" },
    ]);
  });

  it("does not count a gate as an output step", async () => {
    const f = fakeHost();
    const w = doc([p("s1", "a"), { id: "g", kind: "gate", label: "ok?", after: ["s1"] }]);
    const result = await runStandalone(
      f.host,
      { workflow: w },
      { unattendedGate: "approve" },
    ).wait();
    expect(result.outputs).toEqual([]);
    expect(result.status).toBe("succeeded");
  });
});

describe("role to task mapping", () => {
  it("maps agents, tier, model, worktree and readOnly", async () => {
    const f = fakeHost();
    const w = doc([p("s1", "a"), p("s2", "b"), p("s3", "c")], {
      roles: [
        { id: "a", agentId: "ama", permissionMode: "plan", tier: "strong", worktree: "wt" },
        { id: "b", agentId: "claude", model: "m/x", permissionMode: "default" },
        { id: "c", agentId: "codex", permissionMode: "full-auto" },
      ],
    });
    await runStandalone(f.host, { workflow: w }, {}).wait();
    const by = Object.fromEntries(f.calls.map((c) => [stepOf(c), c]));
    expect(by.s1).toMatchObject({
      agent: "general",
      readOnly: true,
      tier: "strong",
      isolation: "worktree",
    });
    expect(by.s2).toMatchObject({ agent: "claude", model: "m/x" });
    expect(by.s2).not.toHaveProperty("readOnly");
    expect(by.s3).toMatchObject({ agent: "codex" });
    expect(by.s3).not.toHaveProperty("readOnly");
    expect(f.logs.some((l) => l.includes("full-auto"))).toBe(true);
  });

  it("puts the contract only in the first message of a role", async () => {
    const f = fakeHost();
    const w = doc([p("s1", "a"), p("s2", "a")], {
      contract: { text: "API", owns: { a: ["src/**"] } },
    });
    await runStandalone(f.host, { workflow: w }, {}).wait();
    expect(f.calls[0]!.prompt).toBe(
      "<contract>\nAPI\nFiles you own (edit only these): src/**\n</contract>\n\ndo s1",
    );
    expect(f.calls[1]!.prompt).toBe("do s2");
  });

  it("substitutes parameters", async () => {
    const f = fakeHost();
    const w = doc([p("s1", "a", [], "review {{dir}}")], { params: [{ name: "dir" }] });
    await runStandalone(f.host, { workflow: w }, { params: { dir: "src" } }).wait();
    expect(f.calls[0]!.prompt).toBe("review src");
  });
});

describe("start checks", () => {
  it("rejects a missing or unknown parameter", () => {
    const f = fakeHost();
    const w = doc([p("s1", "a")], { params: [{ name: "x" }] });
    expect(() => runStandalone(f.host, { workflow: w }, {})).toThrow(/Parameter x has no value/);
    expect(() => runStandalone(f.host, { workflow: w }, { params: { x: "1", y: "2" } })).toThrow(
      /no parameter y/,
    );
    expect(f.calls).toEqual([]);
  });

  it("applies the 2000 / 1800 length rule", () => {
    const f = fakeHost();
    const plain = doc([p("s1", "a", [], "x".repeat(2000))]);
    expect(() => runStandalone(fakeHost().host, { workflow: plain }, {})).not.toThrow();
    const over = doc([p("s1", "a", [], "x".repeat(2001))]);
    expect(() => runStandalone(f.host, { workflow: over }, {})).toThrow(
      "Step s1 is longer than 2000 characters after parameters are filled in.",
    );
    const contracted = doc([p("s1", "a", [], "x".repeat(1801))], { contract: { text: "t" } });
    expect(() => runStandalone(f.host, { workflow: contracted }, {})).toThrow(/longer than 1800/);
    const collect = doc([
      p("s1", "a"),
      {
        id: "c",
        kind: "collect",
        role: "a",
        from: ["s1"],
        after: ["s1"],
        prompt: "x".repeat(1801),
      },
    ]);
    expect(() => runStandalone(f.host, { workflow: collect }, {})).toThrow(/Step c .* 1800/);
    const ok = doc([p("s1", "a", [], "x".repeat(1800))], { contract: { text: "t" } });
    expect(() => runStandalone(fakeHost().host, { workflow: ok }, {})).not.toThrow();
  });

  it("rejects unavailable agents and custom agents", () => {
    const f = fakeHost(undefined, (n) => n !== "claude");
    const w = doc([p("s1", "a")], { roles: [{ id: "a", agentId: "claude" }] });
    expect(() => runStandalone(f.host, { workflow: w }, {})).toThrow(
      "Role a uses agent claude, which is not available here.",
    );
    const c = doc([p("s1", "a")], { roles: [{ id: "a", agentId: "custom:x" }] });
    expect(() => runStandalone(fakeHost().host, { workflow: c }, {})).toThrow(
      /workflow_agent_unavailable|not available here/,
    );
  });

  it("allows one run per session (workflow_busy)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeHost(() => gate.then(() => ({})));
    const w = doc([p("s1", "a")]);
    const run = runStandalone(f.host, { workflow: w }, {});
    let error: { code?: string; message?: string } | undefined;
    try {
      runStandalone(f.host, { workflow: w }, {});
    } catch (e) {
      error = e as { code?: string; message?: string };
    }
    expect(error).toMatchObject({
      code: "workflow_busy",
      message: "A workflow is already running in this session.",
    });
    release();
    await run.wait();
    expect(() => runStandalone(f.host, { workflow: w }, {})).not.toThrow();
  });
});

describe("failure propagation", () => {
  it("skips transitive successors and fails the run after running steps end", async () => {
    const f = fakeHost((req) => (stepOf(req) === "s1" ? failedReport("nope") : {}));
    const w = doc([p("s1", "a"), p("s2", "b", ["s1"]), p("s3", "c", ["s2"]), p("s4", "d")]);
    const result = await runStandalone(f.host, { workflow: w }, {}).wait();
    expect(result.steps.map((s) => s.status)).toEqual(["failed", "skipped", "skipped", "done"]);
    expect(result.status).toBe("failed");
    expect(result.error).toEqual({ code: "step_failed", message: "Step s1 failed: nope" });
    expect(result.steps[0]!.error).toBe("Step s1 failed: nope");
    expect(f.calls.map(stepOf)).toEqual(["s1", "s4"]);
  });

  it("fails a step when the task ends abnormally or spawn throws", async () => {
    const f = fakeHost((req) =>
      stepOf(req) === "s1"
        ? { status: "aborted", text: "stopped here\nmore" }
        : { throws: new Error("boom") },
    );
    const w = doc([p("s1", "a"), p("s2", "b")]);
    const result = await runStandalone(f.host, { workflow: w }, {}).wait();
    expect(result.steps[0]!.error).toBe("Step s1 failed: stopped here");
    expect(result.steps[1]!.error).toBe("Step s2 failed: boom");
  });

  it("treats a blocked report as failure but waiting as done", async () => {
    const f = fakeHost((req) =>
      stepOf(req) === "s1"
        ? { report: { state: "blocked", summary: "need key" } }
        : { report: { state: "waiting", summary: "later" } },
    );
    const result = await runStandalone(
      f.host,
      { workflow: doc([p("s1", "a"), p("s2", "b")]) },
      {},
    ).wait();
    expect(result.steps.map((s) => s.status)).toEqual(["failed", "done"]);
  });
});

describe("gates", () => {
  const w = doc([
    p("s1", "a"),
    { id: "g", kind: "gate", label: "Ship it?", after: ["s1"] },
    p("s2", "b", ["g"]),
  ]);

  it("approves through onGate with a summary of completed steps", async () => {
    const f = fakeHost(() => ready("built"));
    const seen: unknown[] = [];
    const phases: (string | undefined)[] = [];
    const run = runStandalone(
      f.host,
      { workflow: w },
      {
        onGate: async (r) => (seen.push(r), "approve"),
        onUpdate: (u) => u.step?.id === "g" && phases.push(u.step.status + ":" + u.step.phase),
      },
    );
    const result = await run.wait();
    expect(result.status).toBe("succeeded");
    expect(seen).toMatchObject([
      { stepId: "g", label: "Ship it?", completed: [{ stepId: "s1", summary: "built" }] },
    ]);
    expect(phases).toContain("waiting:waiting_human");
    expect(result.steps[1]).toMatchObject({ status: "done", decision: "approve" });
  });

  it("rejects through onGate and skips the successors", async () => {
    const f = fakeHost();
    const result = await runStandalone(
      f.host,
      { workflow: w },
      { onGate: async () => "reject" },
    ).wait();
    expect(result.status).toBe("failed");
    expect(result.error).toEqual({ code: "gate_rejected", message: "Gate g was rejected." });
    expect(result.steps.map((s) => s.status)).toEqual(["done", "failed", "skipped"]);
  });

  it("rejects when nobody can answer, approves with unattendedGate: approve", async () => {
    const r1 = await runStandalone(fakeHost().host, { workflow: w }, {}).wait();
    expect(r1.error).toEqual({
      code: "gate_rejected",
      message: "Gate g was rejected (no one to ask; workflows.unattendedGate is reject).",
    });
    const r2 = await runStandalone(
      fakeHost().host,
      { workflow: w },
      { unattendedGate: "approve" },
    ).wait();
    expect(r2.status).toBe("succeeded");
  });

  it("answers through respondGate", async () => {
    const f = fakeHost();
    const run = runStandalone(f.host, { workflow: w }, { onGate: () => new Promise(() => {}) });
    expect(run.respondGate("g", "approve")).toBe(false);
    await tick();
    expect(run.respondGate("g", "approve")).toBe(true);
    expect((await run.wait()).status).toBe("succeeded");
    expect(run.respondGate("g", "approve")).toBe(false);
  });
});

// ---- verify ----
const lead = (verify = true, maxRetries?: number): WorkflowStep => ({
  id: "c",
  kind: "collect",
  role: "lead",
  from: ["w1", "w2"],
  after: ["w1", "w2"],
  prompt: "collect",
  ...(verify ? { verify: { commands: ["pnpm test"] } } : {}),
  ...(maxRetries === undefined ? {} : { maxRetries }),
});
const vflow = (c = lead()): WorkflowDocument => doc([p("w1", "dev1"), p("w2", "dev2"), c]);

/** 汇总角色的回答依次取自 `answers`；其余步骤 / 修复消息正常完成。 */
function leadScript(answers: Reply[], log: string[] = []): Script {
  let i = 0;
  return (req, _t) => {
    if (req.workflow!.roleId !== "lead") {
      log.push(`${req.workflow!.roleId}:${req.prompt.split("\n")[0]}`);
      return req.taskId === undefined ? {} : { text: `fixed by ${req.workflow!.roleId}` };
    }
    return answers[Math.min(i++, answers.length - 1)]!;
  };
}

describe("collect and verify", () => {
  it("builds the collect message with outputs and the verify instruction", async () => {
    const f = fakeHost(leadScript([ready()]));
    const result = await runStandalone(f.host, { workflow: vflow() }, {}).wait();
    expect(result.status).toBe("succeeded");
    const msg = f.calls.find((c) => stepOf(c) === "c")!.prompt;
    expect(msg).toContain('collect\n\n<step-output step="w1" role="dev1">\nout:w1\n</step-output>');
    expect(msg).toContain('<step-output step="w2" role="dev2">');
    expect(msg).toContain("run `pnpm test` and make sure it succeeds");
    expect(msg).toContain("one of [dev1] [dev2].");
    expect(result.steps[2]).toMatchObject({ status: "done", attempt: 1 });
  });

  it("collects without verify like a prompt step", async () => {
    const f = fakeHost();
    const result = await runStandalone(f.host, { workflow: vflow(lead(false)) }, {}).wait();
    expect(result.status).toBe("succeeded");
    expect(f.calls.find((c) => stepOf(c) === "c")!.prompt).not.toContain("verify");
    expect(result.outputs).toEqual([{ stepId: "c", text: "out:c" }]);
  });

  it("sends only the named role back, fixes, collects again with attempt + 1", async () => {
    const log: string[] = [];
    const f = fakeHost(leadScript([failedReport("[dev2] test broke"), ready()], log));
    const attempts: (number | undefined)[] = [];
    const result = await runStandalone(
      f.host,
      { workflow: vflow() },
      {
        onUpdate: (u) => u.step?.id === "c" && attempts.push(u.step.attempt),
      },
    ).wait();
    expect(result.status).toBe("succeeded");
    const fix = f.calls.filter((c) => c.workflow!.roleId === "dev2" && c.taskId !== undefined);
    expect(fix).toHaveLength(1);
    expect(fix[0]!.prompt).toBe(
      "The collect step c found problems in your part (attempt 1 of 2):\n[dev2] test broke\nFix them, then end with your report.",
    );
    expect(f.calls.filter((c) => c.workflow!.roleId === "dev1")).toHaveLength(1);
    const collects = f.calls.filter((c) => c.workflow!.roleId === "lead");
    expect(collects).toHaveLength(2);
    expect(collects[1]!.taskId).toBe("t3");
    expect(collects[1]!.prompt).toContain(
      "The problems were sent back and fixed (attempt 1 of 2).",
    );
    expect(collects[1]!.prompt).toContain("fixed by dev2");
    expect(collects[1]!.prompt).toContain("out:w1");
    expect(attempts).toContain(2);
    expect(result.steps[2]!.attempt).toBe(2);
  });

  it("sends back every from role when the report names none", async () => {
    const f = fakeHost(leadScript([failedReport("tests fail"), ready()]));
    await runStandalone(f.host, { workflow: vflow() }, {}).wait();
    const fixes = f.calls.filter(
      (c) => c.workflow!.roleId.startsWith("dev") && c.taskId !== undefined,
    );
    expect(fixes.map((c) => c.workflow!.roleId).sort()).toEqual(["dev1", "dev2"]);
  });

  it("retries twice by default and then fails with verify_failed", async () => {
    const f = fakeHost(leadScript([failedReport("[dev1] still bad")]));
    const result = await runStandalone(f.host, { workflow: vflow() }, {}).wait();
    expect(f.calls.filter((c) => c.workflow!.roleId === "lead")).toHaveLength(3);
    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "verify_failed",
      message: "Step c did not pass verification: [dev1] still bad",
    });
  });

  it("honours maxRetries", async () => {
    const f0 = fakeHost(leadScript([failedReport("bad")]));
    await runStandalone(f0.host, { workflow: vflow(lead(true, 0)) }, {}).wait();
    expect(f0.calls.filter((c) => c.workflow!.roleId === "lead")).toHaveLength(1);
    const f3 = fakeHost(leadScript([failedReport("bad")]));
    await runStandalone(f3.host, { workflow: vflow(lead(true, 3)) }, {}).wait();
    expect(f3.calls.filter((c) => c.workflow!.roleId === "lead")).toHaveLength(4);
  });

  it("asks onVerifyFailed when retries are used up: accept", async () => {
    const f = fakeHost(leadScript([failedReport("[dev1] bad")]));
    const asked: unknown[] = [];
    const result = await runStandalone(
      f.host,
      { workflow: vflow(lead(true, 1)) },
      {
        onVerifyFailed: async (x) => (asked.push(x), "accept"),
      },
    ).wait();
    expect(asked).toMatchObject([
      { stepId: "c", reason: "exhausted", summary: "[dev1] bad", attempt: 2 },
    ]);
    expect(result.status).toBe("succeeded");
    expect(result.steps[2]!.status).toBe("done");
    expect(result.steps[2]!.warnings).toHaveLength(1);
    expect(result.steps[2]!.warnings![0]).toContain("[dev1] bad");
  });

  it("asks onVerifyFailed when retries are used up: fail", async () => {
    const f = fakeHost(leadScript([failedReport("bad")]));
    const result = await runStandalone(
      f.host,
      { workflow: vflow(lead(true, 0)) },
      {
        onVerifyFailed: async () => "fail",
      },
    ).wait();
    expect(result.error?.code).toBe("verify_failed");
  });

  it("answers an escalation through respondGate", async () => {
    const f = fakeHost(leadScript([failedReport("bad")]));
    const run = runStandalone(
      f.host,
      { workflow: vflow(lead(true, 0)) },
      {
        onVerifyFailed: () => new Promise(() => {}),
      },
    );
    await tick();
    expect(run.respondGate("c", "approve")).toBe(true);
    expect((await run.wait()).status).toBe("succeeded");
  });

  it("does not retry without a report and escalates as unverified", async () => {
    const f = fakeHost(leadScript([{}]));
    const asked: unknown[] = [];
    const result = await runStandalone(
      f.host,
      { workflow: vflow() },
      {
        onVerifyFailed: async (x) => (asked.push(x), "fail"),
      },
    ).wait();
    expect(f.calls.filter((c) => c.workflow!.roleId === "lead")).toHaveLength(1);
    expect(asked).toMatchObject([{ reason: "unverified" }]);
    expect(result.error).toEqual({
      code: "verify_failed",
      message: "Step c was not verified (no report).",
    });
  });

  it("fails without an asker when there is no report (external runner)", async () => {
    const w = doc([p("w1", "dev1"), p("w2", "dev2"), lead()], {
      roles: [
        { id: "dev1", agentId: "ama" },
        { id: "dev2", agentId: "ama" },
        { id: "lead", agentId: "claude" },
      ],
    });
    const f = fakeHost(leadScript([{ text: "all good" }]));
    const result = await runStandalone(f.host, { workflow: w }, {}).wait();
    expect(result.steps[2]!.status).toBe("failed");
    expect(result.error?.code).toBe("verify_failed");
  });

  it("does not let unattendedGate: approve pass a failed verification", async () => {
    const f = fakeHost(leadScript([failedReport("bad")]));
    const result = await runStandalone(
      f.host,
      { workflow: vflow(lead(true, 0)) },
      {
        unattendedGate: "approve",
      },
    ).wait();
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("verify_failed");
  });

  it("escalates when a role cannot be continued", async () => {
    const answers = [failedReport("[dev2] bad"), ready()];
    const base = leadScript(answers);
    const f = fakeHost((req, t, n) =>
      req.workflow!.roleId === "dev2" && req.taskId !== undefined
        ? { throws: new Error("session gone") }
        : base(req, t, n),
    );
    const asked: unknown[] = [];
    const result = await runStandalone(
      f.host,
      { workflow: vflow() },
      {
        onVerifyFailed: async (x) => (asked.push(x), "fail"),
      },
    ).wait();
    expect(asked).toMatchObject([{ reason: "not_reopenable", summary: "[dev2] bad" }]);
    expect(result.error?.code).toBe("verify_failed");
    expect(result.steps[1]!.status).toBe("done");
  });

  it("escalates when the report names a role without a known task", async () => {
    // dev1 spawn returned no taskId, so it can never be continued.
    const base = leadScript([failedReport("[dev1] bad")]);
    const f = fakeHost((req, t, n) =>
      req.workflow!.roleId === "dev1" ? { taskId: undefined as never } : base(req, t, n),
    );
    const result = await runStandalone(f.host, { workflow: vflow() }, {}).wait();
    expect(result.error?.code).toBe("verify_failed");
    expect(
      f.calls.filter((c) => c.taskId !== undefined && c.workflow!.roleId === "dev1"),
    ).toHaveLength(0);
  });

  it("fails the collect step when a reopened step fails", async () => {
    const base = leadScript([failedReport("[dev1] bad")]);
    const f = fakeHost((req, t, n) =>
      req.workflow!.roleId === "dev1" && req.taskId !== undefined
        ? failedReport("cannot fix")
        : base(req, t, n),
    );
    const result = await runStandalone(f.host, { workflow: vflow() }, {}).wait();
    expect(result.steps.map((s) => s.status)).toEqual(["failed", "done", "failed"]);
    expect(result.error).toEqual({ code: "step_failed", message: "Step w1 failed: cannot fix" });
  });
});

describe("run budget", () => {
  it("fails the next step with limit_reached once the cost is reached", async () => {
    const f = fakeHost((req, taskId) => {
      f.tasks.push({
        taskId,
        agent: "general",
        runner: "ama",
        description: "",
        background: false,
        status: "completed",
        startedAt: 0,
        costUsd: 1.5,
        turns: 3,
        workflow: req.workflow!,
      });
      return {};
    });
    const w = doc([p("s1", "a"), p("s2", "b", ["s1"]), p("s3", "c", ["s2"])]);
    const result = await runStandalone(
      f.host,
      { workflow: w },
      { limits: { maxCostUsd: 1 } },
    ).wait();
    expect(f.calls).toHaveLength(1);
    expect(result.steps.map((s) => s.status)).toEqual(["done", "failed", "skipped"]);
    expect(result.error).toEqual({
      code: "limit_reached",
      message: "The workflow run reached the $1.00 cost limit ($1.50 spent).",
    });
  });

  it("counts descendants and the turn limit", async () => {
    const f = fakeHost((req, taskId) => {
      f.tasks.push(
        {
          taskId,
          agent: "g",
          runner: "ama",
          description: "",
          background: false,
          status: "completed",
          startedAt: 0,
          turns: 2,
          workflow: req.workflow!,
        },
        {
          taskId: `${taskId}c`,
          agent: "g",
          runner: "ama",
          description: "",
          background: false,
          status: "completed",
          startedAt: 0,
          turns: 4,
          parentTaskId: taskId,
        },
        {
          taskId: "other",
          agent: "g",
          runner: "ama",
          description: "",
          background: false,
          status: "completed",
          startedAt: 0,
          turns: 99,
        },
      );
      return {};
    });
    const result = await runStandalone(
      f.host,
      { workflow: doc([p("s1", "a"), p("s2", "b", ["s1"])]) },
      {
        limits: { maxTurns: 6 },
      },
    ).wait();
    expect(result.error).toEqual({
      code: "limit_reached",
      message: "The workflow run reached the 6-turn limit.",
    });
  });

  it("checks before retries too", async () => {
    let cost = 0;
    const base = leadScript([failedReport("bad")]);
    const f = fakeHost((req, t, n) => {
      cost += 1;
      f.tasks.length = 0;
      f.tasks.push({
        taskId: t,
        agent: "g",
        runner: "ama",
        description: "",
        background: false,
        status: "completed",
        startedAt: 0,
        costUsd: cost,
        workflow: req.workflow!,
      });
      return base(req, t, n);
    });
    const result = await runStandalone(
      f.host,
      { workflow: vflow() },
      { limits: { maxCostUsd: 4 } },
    ).wait();
    expect(result.error?.code).toBe("limit_reached");
  });
});

describe("phases", () => {
  it("reports waiting_children while a child task of the step task runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeHost(async () => (await gate, {}));
    const updates: WorkflowUpdate[] = [];
    const run = runStandalone(
      f.host,
      { workflow: doc([p("s1", "a")]) },
      { onUpdate: (u) => updates.push(u) },
    );
    await tick();
    const own: TaskInfo = {
      taskId: "t1",
      agent: "g",
      runner: "ama",
      description: "",
      background: false,
      status: "running",
      startedAt: 0,
      workflow: { runId: run.runId, workflowId: "inline", stepId: "s1", roleId: "a" },
    };
    const child: TaskInfo = {
      taskId: "k1",
      agent: "g",
      runner: "ama",
      description: "",
      background: false,
      status: "running",
      startedAt: 0,
      parentTaskId: "t1",
    };
    f.tasks.push(own, child);
    f.listeners.forEach((l) => l({ type: "subagent_start", taskId: "k1", parentTaskId: "t1" }));
    const phaseNow = (): string | undefined =>
      updates.filter((u) => u.step?.id === "s1").at(-1)?.step?.phase;
    expect(phaseNow()).toBe("waiting_children");
    expect(updates.filter((u) => u.step?.id === "s1").at(-1)!.step!.taskId).toBe("t1");
    child.status = "completed";
    f.listeners.forEach((l) => l({ type: "subagent_end", taskId: "k1", parentTaskId: "t1" }));
    expect(phaseNow()).toBe("running");
    release();
    await run.wait();
    expect(f.listeners).toHaveLength(0);
  });

  it("uses collecting and verifying phases for collect steps", async () => {
    const seen: Record<string, Set<string | undefined>> = {};
    const f = fakeHost(leadScript([ready()]));
    await runStandalone(
      f.host,
      { workflow: vflow() },
      {
        onUpdate: (u) => u.step && (seen[u.step.id] ??= new Set()).add(u.step.phase),
      },
    ).wait();
    expect(seen.c!.has("verifying")).toBe(true);
    expect(seen.w1!.has("running")).toBe(true);
    const g = fakeHost();
    const plain: Record<string, Set<string | undefined>> = {};
    await runStandalone(
      g.host,
      { workflow: vflow(lead(false)) },
      {
        onUpdate: (u) => u.step && (plain[u.step.id] ??= new Set()).add(u.step.phase),
      },
    ).wait();
    expect(plain.c!.has("collecting")).toBe(true);
  });
});

describe("cancel", () => {
  function hangingHost() {
    return fakeHost(
      (req) =>
        new Promise<Reply>((_r, reject) => {
          req.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
  }
  it("stops running tasks and marks the rest cancelled", async () => {
    const f = hangingHost();
    const run = runStandalone(f.host, { workflow: doc([p("s1", "a"), p("s2", "b", ["s1"])]) }, {});
    await tick();
    await run.cancel();
    const result = await run.wait();
    expect(f.calls[0]!.signal.aborted).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(result.error).toEqual({ code: "cancelled", message: "The run was cancelled." });
    expect(result.steps.map((s) => s.status)).toEqual(["cancelled", "cancelled"]);
  });
  it("follows options.signal and cancels a waiting gate", async () => {
    const ac = new AbortController();
    const w = doc([p("s1", "a"), { id: "g", kind: "gate", label: "?", after: ["s1"] }]);
    const run = runStandalone(
      fakeHost().host,
      { workflow: w },
      { signal: ac.signal, onGate: () => new Promise(() => {}) },
    );
    await tick();
    ac.abort();
    const result = await run.wait();
    expect(result.status).toBe("cancelled");
    expect(result.steps.map((s) => s.status)).toEqual(["done", "cancelled"]);
  });
  it("frees the session for the next run", async () => {
    const f = hangingHost();
    const run = runStandalone(f.host, { workflow: doc([p("s1", "a")]) }, {});
    await tick();
    await run.cancel();
    expect(() =>
      runStandalone(fakeHost().host, { workflow: doc([p("s1", "a")]) }, {}),
    ).not.toThrow();
    expect(() =>
      runStandalone(f.host, { workflow: doc([p("s1", "a")]) }, {}).cancel(),
    ).not.toThrow();
  });
});

describe("snapshots and updates", () => {
  it("records a snapshot per change and emits updates ending with a terminal one", async () => {
    const f = fakeHost();
    const updates: WorkflowUpdate[] = [];
    const file = {
      id: "wf1",
      scope: "project" as const,
      filePath: "/p/.ama/workflows/wf1.md",
      hash: "abc",
      workflow: doc([p("s1", "a"), p("s2", "b", ["s1"])]),
    };
    const run = runStandalone(f.host, file, { onUpdate: (u) => updates.push(u) });
    const result = await run.wait();
    expect(updates[0]).toMatchObject({
      workflowId: "wf1",
      title: "T",
      status: "running",
      host: false,
    });
    expect(updates[0]).not.toHaveProperty("step");
    const last = updates.at(-1)!;
    expect(last).toMatchObject({ status: "succeeded" });
    expect(last).not.toHaveProperty("step");
    expect(f.emitted).toEqual(updates);
    expect(f.records.length).toBe(updates.length);
    const final = f.records.at(-1)!;
    expect(final).toMatchObject({
      runId: run.runId,
      workflowId: "wf1",
      source: { scope: "project", filePath: "/p/.ama/workflows/wf1.md", hash: "abc" },
      status: "succeeded",
    });
    expect(final.endedAt).toBeGreaterThanOrEqual(final.startedAt);
    expect(final.steps.map((s) => s.status)).toEqual(["done", "done"]);
    expect(f.records[0]!.steps.map((s) => s.status)).toEqual(["pending", "pending"]);
    expect(result.steps[0]!.taskId).toBe("t1");
    expect(result.steps[0]!.startedAt).toBeDefined();
    expect(result.steps[0]!.endedAt).toBeDefined();
  });
  it("survives a throwing onUpdate", async () => {
    const f = fakeHost();
    const result = await runStandalone(
      f.host,
      { workflow: doc([p("s1", "a")]) },
      {
        onUpdate: () => {
          throw new Error("ui");
        },
      },
    ).wait();
    expect(result.status).toBe("succeeded");
    expect(f.logs.some((l) => l.includes("ui"))).toBe(true);
  });
});
