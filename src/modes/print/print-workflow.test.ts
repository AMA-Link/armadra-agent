import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AmaError } from "../../errors.js";
import { parseArgs } from "../../cli/args.js";
import type { CliIo } from "../../cli/deps.js";
import { ExitCode } from "../../cli/exit-codes.js";
import type { Runtime } from "../../cli/runtime.js";
import type {
  WorkflowRunHandle,
  WorkflowRunOptions,
  WorkflowRunResult,
} from "../../workflows/run-types.js";
import { runPrintWorkflow } from "./print-workflow.js";

const doc = (title: string): string =>
  `---\nversion: 2\ntitle: ${title}\nparams:\n  - name: topic\nroles:\n  - id: a\n    agentId: ama\nsteps:\n  - id: s1\n    kind: prompt\n    role: a\n    prompt: go {{topic}}\n---\n`;

let root: string;
let cwd: string;
let out: string[];
let err: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ama-print-wf-"));
  cwd = join(root, "proj");
  mkdirSync(join(root, "cfg", "workflows"), { recursive: true });
  mkdirSync(join(cwd, ".ama", "workflows"), { recursive: true });
  writeFileSync(join(root, "cfg", "workflows", "ok.md"), doc("Ok"));
  writeFileSync(join(root, "cfg", "workflows", "bad.md"), "---\nversion: 2\n---\n");
  writeFileSync(join(cwd, ".ama", "workflows", "proj.md"), doc("Proj"));
  out = [];
  err = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function runtime(over: { trusted?: boolean; config?: object } = {}): Runtime {
  const session = {
    state: { sessionId: "s1" },
    manager: { id: "s1" },
    cwd,
    subscribe: () => () => undefined,
  };
  return {
    paths: { cwd, configDir: join(root, "cfg") },
    config: over.config ?? {},
    trust: { trusted: over.trusted ?? true },
    sessionManager: {},
    session,
    host: undefined,
  } as unknown as Runtime;
}

function exec(
  argv: string[],
  result: WorkflowRunResult | Error,
  over: Parameters<typeof runtime>[0] = {},
): { code: Promise<number>; seen: () => WorkflowRunOptions | undefined } {
  const parsed = parseArgs(["-p", ...argv]);
  if (parsed.kind !== "run") throw new Error("subcommand");
  const io = {
    stdout: (t: string) => void out.push(t),
    stderr: (t: string) => void err.push(t),
    env: {},
    cwd,
  } as unknown as CliIo;
  let seen: WorkflowRunOptions | undefined;
  const code = runPrintWorkflow(
    runtime(over),
    { args: parsed.args, prompt: undefined, io },
    (_host, _file, options) => {
      seen = options;
      if (result instanceof Error) throw result;
      return { wait: async () => result } as unknown as WorkflowRunHandle;
    },
  );
  return { code, seen: () => seen };
}

const done = (over: Partial<WorkflowRunResult> = {}): WorkflowRunResult => ({
  runId: "r1",
  workflowId: "ok",
  status: "succeeded",
  steps: [],
  outputs: [
    { stepId: "s1", text: "first" },
    { stepId: "s2", text: "second" },
  ],
  ...over,
});

describe("ama -p --workflow", () => {
  it("成功：outputs 以空行分隔写 stdout，退出 0；传入 params、缺省 unattendedGate、limits", async () => {
    const r = exec(["--workflow", "ok", "--param", "topic=x", "--max-cost", "2"], done());
    expect(await r.code).toBe(ExitCode.Ok);
    expect(out.join("")).toBe("first\n\nsecond\n");
    expect(r.seen()).toMatchObject({
      params: { topic: "x" },
      unattendedGate: "reject",
      limits: { maxCostUsd: 2 },
    });
  });

  it("config workflows.unattendedGate 传给调度器", async () => {
    const r = exec(["--workflow", "ok"], done(), {
      config: { workflows: { unattendedGate: "approve" } },
    });
    await r.code;
    expect(r.seen()?.unattendedGate).toBe("approve");
  });

  it("找不到 / 无效 → 2；未信任项目目录有提示且不被发现", async () => {
    expect(await exec(["--workflow", "nope"], done()).code).toBe(ExitCode.Usage);
    expect(err.join("")).toContain("没有名为 nope 的工作流");
    err.length = 0;
    expect(await exec(["--workflow", "bad"], done()).code).toBe(ExitCode.Usage);
    expect(err.join("")).toContain("工作流 bad 无效");
    err.length = 0;
    expect(await exec(["--workflow", "proj"], done(), { trusted: false }).code).toBe(
      ExitCode.Usage,
    );
    expect(err.join("")).toContain("项目未受信任");
    expect(await exec(["--workflow", "proj"], done()).code).toBe(ExitCode.Ok);
  });

  it("起跑检查错误：参数类 2、忙碌 1，消息走 stderr", async () => {
    expect(
      await exec(
        ["--workflow", "ok"],
        new AmaError("missing_param", "Parameter topic has no value."),
      ).code,
    ).toBe(ExitCode.Usage);
    expect(err.join("")).toBe("ama: Parameter topic has no value.\n");
    expect(
      await exec(
        ["--workflow", "ok"],
        new AmaError("workflow_busy", "A workflow is already running."),
      ).code,
    ).toBe(ExitCode.RuntimeError);
  });

  it("失败 1、预算 8、gate 被拒 10", async () => {
    const failed = (code: string, message: string) =>
      done({ status: "failed", outputs: [], error: { code, message } });
    expect(await exec(["--workflow", "ok"], failed("step_failed", "Step s1 failed: x")).code).toBe(
      1,
    );
    expect(
      await exec(["--workflow", "ok"], failed("verify_failed", "Step s1 did not pass")).code,
    ).toBe(1);
    expect(
      await exec(
        ["--workflow", "ok"],
        failed("limit_reached", "The workflow run reached the 2-turn limit."),
      ).code,
    ).toBe(8);
    expect(out.join("")).toBe("");
    err.length = 0;
    expect(
      await exec(
        ["--workflow", "ok"],
        failed(
          "gate_rejected",
          "Gate g was rejected (no one to ask; workflows.unattendedGate is reject).",
        ),
      ).code,
    ).toBe(10);
    expect(err.join("")).toContain("Gate g was rejected");
  });

  it("交给宿主：打印 url（无则 runId），退出 0；workflow_unsupported 等人确认 → 10", async () => {
    const started = done({
      status: "running",
      outputs: [],
      host: { runId: "h1", url: "armadra://wf/h1" },
    });
    expect(await exec(["--workflow", "ok"], started).code).toBe(0);
    expect(out.join("")).toBe("armadra://wf/h1\n");
    out.length = 0;
    expect(
      await exec(
        ["--workflow", "ok"],
        done({ status: "running", outputs: [], host: { runId: "h2" } }),
      ).code,
    ).toBe(0);
    expect(out.join("")).toBe("h2\n");
    err.length = 0;
    const waiting = done({
      status: "waiting",
      outputs: [],
      error: { code: "workflow_unsupported", message: "needs confirm" },
    });
    expect(await exec(["--workflow", "ok"], waiting).code).toBe(10);
    expect(err.join("")).toContain("needs confirm");
    const failedHost = done({
      status: "failed",
      outputs: [],
      error: { code: "step_failed", message: "boom" },
    });
    expect(await exec(["--workflow", "ok"], failedHost).code).toBe(1);
  });

  it("json：一个 result 对象带 workflow 与 workflowUpdates", async () => {
    expect(await exec(["--workflow", "ok", "--output-format", "json"], done()).code).toBe(0);
    const line = JSON.parse(out.join("").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ type: "result", workflowId: "ok", workflowUpdates: [] });
    expect((line["workflow"] as { status: string }).status).toBe("succeeded");
  });
});
