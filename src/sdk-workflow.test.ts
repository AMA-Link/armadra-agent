/**
 * [#318] SDK `listWorkflows()` / `runWorkflow()`：用脚本化的 `fake` 供应商跑通缩小版「拆分 API 与 UI」样例
 * （prompt → prompt → gate → collect），并覆盖 gate 作答、无人值守、起跑检查错误与内联文档校验。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../test/helpers/tmp-home.js";
import { createDefaultApiRegistry } from "./ai/apis/api.js";
import { FakeProvider } from "./ai/fake/fake-provider.js";
import type { FakeResponse } from "./ai/fake/fake-script.js";
import * as sdk from "./index.js";
import { createAgentSession, listWorkflows, runWorkflow, type SdkAgentSession } from "./sdk.js";
import type { WorkflowUpdate } from "./workflows/run-types.js";
import type { WorkflowDocument } from "./workflows/types.js";

let home: TmpHome | undefined;
let session: SdkAgentSession | undefined;
afterEach(async () => {
  await session?.dispose();
  session = undefined;
  home?.cleanup();
  home = undefined;
});

const MINI = `---
version: 2
title: Split a feature into API and UI
params:
  - name: feature
    type: text
roles:
  - id: api
    agentId: ama
  - id: ui
    agentId: ama
  - id: lead
    agentId: ama
steps:
  - id: build-api
    kind: prompt
    role: api
    prompt: "Implement the server side of {{feature}}."
  - id: build-ui
    kind: prompt
    role: ui
    after: [build-api]
    prompt: "Implement the UI of {{feature}}."
  - id: review
    kind: gate
    label: Review both parts
    after: [build-ui]
  - id: integrate
    kind: collect
    role: lead
    from: [build-api, build-ui]
    after: [review, build-api, build-ui]
    prompt: Merge both parts and summarize.
---

For people only.
`;

const script: FakeResponse[] = [
  { text: "api done", usage: { input: 10, output: 2 } },
  { text: "ui done", usage: { input: 10, output: 2 } },
  { text: "merged", usage: { input: 10, output: 2 } },
];

async function boot(responses: FakeResponse[] = script) {
  home = createTmpHome("ama-sdk-wf-");
  const dir = join(home.cwd, ".ama", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "feature-split.md"), MINI);
  writeFileSync(join(dir, "broken.md"), "---\nversion: 1\n---\n");
  const fake = new FakeProvider(responses);
  const apis = createDefaultApiRegistry();
  apis.register(fake.api);
  session = await createAgentSession({
    cwd: home.cwd,
    model: "fake/echo",
    apis,
    auth: { kind: "none" },
    permission: { mode: "full-auto" },
  });
  return { fake, cwd: home.cwd, configDir: join(home.root, "config") };
}

describe("SDK 工作流", () => {
  it("index 导出 listWorkflows / runWorkflow", () => {
    expect(sdk.listWorkflows).toBe(listWorkflows);
    expect(sdk.runWorkflow).toBe(runWorkflow);
  });

  it("runWorkflow 缺省取会话的信任，显式 trusted: false 时找不到项目级工作流", async () => {
    const { configDir } = await boot();
    expect(() => runWorkflow(session!, "feature-split", { configDir, trusted: false })).toThrow(
      /No workflow named feature-split\./,
    );
    const handle = runWorkflow(session!, "feature-split", {
      configDir,
      params: { feature: "x" },
      unattendedGate: "approve",
    });
    await handle.cancel();
    await handle.wait();
  });

  it("listWorkflows：有效与无效文件；未信任时跳过项目级目录", async () => {
    const { cwd, configDir } = await boot();
    const all = listWorkflows({ cwd, configDir });
    expect(all.map((w) => [w.id, w.valid])).toEqual([
      ["broken", false],
      ["feature-split", true],
    ]);
    expect(all.find((w) => w.id === "feature-split")).toMatchObject({
      title: "Split a feature into API and UI",
      roles: 3,
      steps: 4,
      scope: "project",
    });
    expect(all.find((w) => w.id === "broken")?.error).toBeTruthy();
    expect(listWorkflows({ cwd, configDir, trusted: false })).toEqual([]);
  });

  it("runWorkflow：fake 供应商跑通 prompt → prompt → gate（onGate approve）→ collect，事件逐步更新", async () => {
    const { fake, cwd, configDir } = await boot();
    const updates: WorkflowUpdate[] = [];
    const gates: string[] = [];
    const handle = runWorkflow(session!, "feature-split", {
      cwd,
      configDir,
      params: { feature: "item list" },
      onUpdate: (u) => updates.push(u),
      onGate: async (request) => {
        gates.push(`${request.stepId}:${request.completed.map((c) => c.stepId).join(",")}`);
        return "approve";
      },
    });
    const result = await handle.wait();
    expect(result.status).toBe("succeeded");
    expect(result.steps.map((s) => [s.id, s.status])).toEqual([
      ["build-api", "done"],
      ["build-ui", "done"],
      ["review", "done"],
      ["integrate", "done"],
    ]);
    expect(result.steps.find((s) => s.id === "review")?.decision).toBe("approve");
    expect(result.outputs).toEqual([{ stepId: "integrate", text: "merged" }]);
    expect(gates).toEqual(["review:build-api,build-ui"]);
    // 运行开始与结束各一条不带 step 的更新；中间带步骤
    expect(updates[0]).toMatchObject({ workflowId: "feature-split", status: "running" });
    expect(updates[0]!.step).toBeUndefined();
    expect(updates.at(-1)).toMatchObject({ status: "succeeded" });
    expect(updates.at(-1)!.step).toBeUndefined();
    expect(updates.some((u) => u.step?.id === "review" && u.step.phase === "waiting_human")).toBe(
      true,
    );
    // 参数代入后才发给模型
    const prompts = fake.calls.map((c) => JSON.stringify(c.context.messages));
    expect(prompts[0]).toContain("Implement the server side of item list.");
    expect(prompts[1]).toContain("Implement the UI of item list.");
    expect(prompts[2]).toContain("Merge both parts and summarize.");
  });

  it("没有 onGate：按 unattendedGate；缺省 reject → gate_rejected，后继 skipped", async () => {
    const { cwd, configDir } = await boot();
    const rejected = await runWorkflow(session!, "feature-split", {
      cwd,
      configDir,
      params: { feature: "x" },
    }).wait();
    expect(rejected.status).toBe("failed");
    expect(rejected.error?.code).toBe("gate_rejected");
    expect(rejected.steps.find((s) => s.id === "integrate")?.status).toBe("skipped");
  });

  it("unattendedGate: approve 放行；respondGate 也能作答", async () => {
    const { cwd, configDir } = await boot();
    const approved = await runWorkflow(session!, "feature-split", {
      cwd,
      configDir,
      params: { feature: "x" },
      unattendedGate: "approve",
    }).wait();
    expect(approved.status).toBe("succeeded");
  });

  it("respondGate：onGate 悬而未决时由句柄作答", async () => {
    const { cwd, configDir } = await boot();
    const handle = runWorkflow(session!, "feature-split", {
      cwd,
      configDir,
      params: { feature: "x" },
      onGate: () => new Promise(() => undefined),
      onUpdate: (u) => {
        if (u.step?.id === "review" && u.step.status === "waiting")
          queueMicrotask(() => handle.respondGate("review", "approve"));
      },
    });
    expect((await handle.wait()).status).toBe("succeeded");
    expect(handle.respondGate("review", "approve")).toBe(false);
  });

  it("起跑检查：找不到、无效、缺参数、未声明参数同步抛 AmaError", async () => {
    const { cwd, configDir } = await boot();
    const base = { cwd, configDir };
    expect(() => runWorkflow(session!, "nope", base)).toThrow(/No workflow named nope\./);
    expect(() => runWorkflow(session!, "broken", base)).toThrow(/Workflow broken is invalid/);
    expect(() => runWorkflow(session!, "feature-split", base)).toThrow(
      /Parameter feature has no value\./,
    );
    expect(() =>
      runWorkflow(session!, "feature-split", { ...base, params: { feature: "x", extra: "y" } }),
    ).toThrow(/has no parameter extra/);
  });

  it("内联文档：校验后单独运行；无效文档抛 invalid_workflow", async () => {
    await boot([{ text: "inline done" }]);
    const doc: WorkflowDocument = {
      version: 2,
      title: "Inline",
      roles: [{ id: "solo", agentId: "ama" }],
      steps: [{ id: "only", kind: "prompt", role: "solo", prompt: "Say it.", after: [] }],
    };
    const result = await runWorkflow(session!, doc).wait();
    expect(result).toMatchObject({ status: "succeeded", workflowId: "inline" });
    expect(result.outputs).toEqual([{ stepId: "only", text: "inline done" }]);
    expect(() => runWorkflow(session!, { version: 2 } as unknown as WorkflowDocument)).toThrow(
      /Workflow is invalid/,
    );
  });
});
