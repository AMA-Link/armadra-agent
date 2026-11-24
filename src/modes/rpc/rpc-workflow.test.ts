/**
 * [#318] RPC 工作流命令：`get_workflows` / `run_workflow` / `respond_workflow_gate` / `cancel_workflow`、
 * `workflow_update` 事件、能力 `workflow_gates`（声明才交客户端作答）、黄金记录 workflow.out.jsonl。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  driveRpc,
  normalizeLine,
  rpcGolden,
  type Driver,
  type Line,
} from "../../../test/helpers/rpc-driver.js";
import type { ComposeHarness } from "../../../test/helpers/compose-harness.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import type { RpcCapability, RpcCommandMap, RpcWorkflowResults } from "../../rpc.js";
import { RPC_CAPABILITIES } from "./rpc-mode.js";

const SPLIT = `---
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
`;

const VERIFIED = `---
version: 2
title: Verified build
roles:
  - id: dev
    agentId: ama
  - id: lead
    agentId: ama
steps:
  - id: build
    kind: prompt
    role: dev
    prompt: Build it.
  - id: collect
    kind: collect
    role: lead
    from: [build]
    after: [build]
    prompt: Collect the build.
    verify:
      checklist: ["It works"]
    maxRetries: 0
---
`;

const script: FakeResponse[] = [
  { text: "api done", usage: { input: 10, output: 2 } },
  { text: "ui done", usage: { input: 10, output: 2 } },
  { text: "merged", usage: { input: 10, output: 2 } },
];

function setup(h: ComposeHarness): void {
  const dir = join(h.home.configDir, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "feature-split.md"), SPLIT);
  writeFileSync(join(dir, "verified.md"), VERIFIED);
}

const isUpdate = (l: Line): boolean => l["type"] === "workflow_update";
const stepUpdate =
  (stepId: string, status: string) =>
  (l: Line): boolean => {
    const step = l["step"] as { id: string; status: string } | undefined;
    return isUpdate(l) && step?.id === stepId && step.status === status;
  };
const terminal =
  (status: string) =>
  (l: Line): boolean =>
    isUpdate(l) && l["step"] === undefined && l["status"] === status;

async function declare(d: Driver, ...capabilities: RpcCapability[]): Promise<void> {
  d.send({ id: "caps", type: "set_client_capabilities", capabilities });
  await d.waitFor((l) => l["id"] === "caps", "caps");
}

async function request(d: Driver, id: string, command: object): Promise<Line> {
  d.send({ id, ...command });
  return d.waitFor((l) => l["id"] === id, id);
}

describe("RPC 工作流", () => {
  it("接口形状：命令、返回值与能力", () => {
    expectTypeOf<RpcCommandMap["run_workflow"]>().toEqualTypeOf<{
      workflowId: string;
      params?: Record<string, string>;
    }>();
    expectTypeOf<RpcCommandMap["cancel_workflow"]>().toEqualTypeOf<{ runId: string }>();
    expectTypeOf<RpcWorkflowResults["run_workflow"]>().toEqualTypeOf<{
      runId: string;
      host: boolean;
      url?: string;
    }>();
    expect(RPC_CAPABILITIES).toContain("workflow_gates");
  });

  it("get_workflows：列出摘要；未知 id → workflow_not_found；参数类型错 → invalid_arguments", async () => {
    const { lines } = await driveRpc(
      undefined,
      async (d) => {
        await request(d, "list", { type: "get_workflows" });
        await request(d, "nope", { type: "run_workflow", workflowId: "nope" });
        await request(d, "badp", {
          type: "run_workflow",
          workflowId: "feature-split",
          params: { feature: 1 },
        });
        await request(d, "noid", { type: "run_workflow" });
        await request(d, "missing", { type: "run_workflow", workflowId: "feature-split" });
      },
      { setup },
    );
    const by = (id: string): Line => lines.find((l) => l["id"] === id)!;
    const list = (by("list")["data"] as { workflows: { id: string; valid: boolean }[] }).workflows;
    expect(list.map((w) => [w.id, w.valid])).toEqual([
      ["feature-split", true],
      ["verified", true],
    ]);
    expect(by("nope")).toMatchObject({ success: false, code: "workflow_not_found" });
    expect(by("badp")).toMatchObject({ success: false, code: "invalid_arguments" });
    expect(by("noid")).toMatchObject({ success: false, code: "invalid_arguments" });
    expect(by("missing")).toMatchObject({ success: false, code: "missing_param" });
  });

  it("workflow.out.jsonl：声明 workflow_gates → 步骤更新 → gate 等客户端 → approve → 收尾", async () => {
    const { lines, h, code } = await driveRpc(
      script,
      async (d) => {
        await declare(d, "workflow_gates");
        const started = await request(d, "run", {
          type: "run_workflow",
          workflowId: "feature-split",
          params: { feature: "item list" },
        });
        expect(started).toMatchObject({ success: true, data: { host: false } });
        const waiting = await d.waitFor(stepUpdate("review", "waiting"), "gate waiting");
        expect(waiting["step"]).toMatchObject({ phase: "waiting_human" });
        const runId = (started["data"] as { runId: string }).runId;
        // 不在等的 gate / 未知运行：ok false
        expect(
          (
            await request(d, "r0", {
              type: "respond_workflow_gate",
              runId,
              stepId: "build-api",
              decision: "approve",
            })
          )["data"],
        ).toEqual({ ok: false });
        expect(
          (
            await request(d, "r1", {
              type: "respond_workflow_gate",
              runId: "nope",
              stepId: "review",
              decision: "approve",
            })
          )["data"],
        ).toEqual({ ok: false });
        expect(
          await request(d, "r2", {
            type: "respond_workflow_gate",
            runId,
            stepId: "review",
            decision: "maybe",
          }),
        ).toMatchObject({ success: false, code: "invalid_arguments" });
        expect(
          (
            await request(d, "r3", {
              type: "respond_workflow_gate",
              runId,
              stepId: "review",
              decision: "approve",
            })
          )["data"],
        ).toEqual({ ok: true });
        await d.waitFor(terminal("succeeded"), "run succeeded");
      },
      { setup },
    );
    expect(code).toBe(0);
    const kept = lines.filter(
      (l) => isUpdate(l) || (l["type"] === "response" && ["run", "r3"].includes(String(l["id"]))),
    );
    const text = kept
      .map((l) =>
        normalizeLine(l, h.home.root)
          .replace(/"(startedAt|endedAt)":\d+/g, '"$1":0')
          .replace(/wf-[0-9a-f]{8}/g, "<run>"),
      )
      .join("\n");
    rpcGolden("workflow.out.jsonl", `${text}\n`);
    const steps = kept.filter(isUpdate).flatMap((l) => {
      const s = l["step"] as { id: string; status: string } | undefined;
      return s === undefined ? [] : [`${s.id}:${s.status}`];
    });
    expect(steps.filter((s) => s.startsWith("review"))).toEqual([
      "review:running",
      "review:waiting",
      "review:done",
    ]);
    expect(kept.filter(isUpdate).every((l) => l["workflowId"] === "feature-split")).toBe(true);
  });

  it("没声明 workflow_gates：gate 按 unattendedGate（缺省 reject）；验证升级一律失败", async () => {
    const { lines } = await driveRpc(
      script,
      async (d) => {
        await request(d, "a", {
          type: "run_workflow",
          workflowId: "feature-split",
          params: { feature: "x" },
        });
        await d.waitFor(terminal("failed"), "gate rejected");
        await request(d, "b", { type: "run_workflow", workflowId: "verified" });
        await d.waitFor(
          (l) =>
            isUpdate(l) &&
            l["workflowId"] === "verified" &&
            l["status"] === "failed" &&
            l["step"] === undefined,
          "verify failed",
        );
      },
      { setup },
    );
    const review = lines.find(stepUpdate("review", "failed"))!;
    expect(review["step"]).toMatchObject({ error: expect.stringContaining("no one to ask") });
    const collect = lines.find(stepUpdate("collect", "failed"))!;
    expect(collect["step"]).toMatchObject({ error: expect.stringContaining("was not verified") });
    expect(lines.some(stepUpdate("collect", "waiting"))).toBe(false);
  });

  it("声明 workflow_gates：验证升级交客户端，approve = 接受并带 warning", async () => {
    const { lines } = await driveRpc(
      [{ text: "built" }, { text: "collected without a report" }],
      async (d) => {
        await declare(d, "workflow_gates");
        const started = await request(d, "v", { type: "run_workflow", workflowId: "verified" });
        const waiting = await d.waitFor(stepUpdate("collect", "waiting"), "verify escalation");
        expect(waiting["step"]).toMatchObject({ phase: "waiting_human" });
        const runId = (started["data"] as { runId: string }).runId;
        await request(d, "ok", {
          type: "respond_workflow_gate",
          runId,
          stepId: "collect",
          decision: "approve",
        });
        await d.waitFor(terminal("succeeded"), "accepted");
      },
      { setup },
    );
    const done = lines.find(stepUpdate("collect", "done"))!;
    expect((done["step"] as { warnings: string[] }).warnings[0]).toContain("accepted");
  });

  it("同时只允许一个运行（workflow_busy）；cancel_workflow 取消等人的运行", async () => {
    const { lines } = await driveRpc(
      script,
      async (d) => {
        await declare(d, "workflow_gates");
        const started = await request(d, "one", {
          type: "run_workflow",
          workflowId: "feature-split",
          params: { feature: "x" },
        });
        await d.waitFor(stepUpdate("review", "waiting"), "gate waiting");
        expect(
          await request(d, "two", { type: "run_workflow", workflowId: "verified" }),
        ).toMatchObject({
          success: false,
          code: "workflow_busy",
        });
        const runId = (started["data"] as { runId: string }).runId;
        expect((await request(d, "bye", { type: "cancel_workflow", runId }))["data"]).toEqual({
          ok: true,
        });
        await d.waitFor(terminal("cancelled"), "cancelled");
        expect((await request(d, "again", { type: "cancel_workflow", runId }))["data"]).toEqual({
          ok: false,
        });
      },
      { setup },
    );
    expect(lines.find(stepUpdate("review", "cancelled"))).toBeDefined();
  });

  it("stdin 关闭时等人的 gate 按拒绝收口，进程正常退出", async () => {
    const { code, lines } = await driveRpc(
      script,
      async (d) => {
        await declare(d, "workflow_gates");
        await request(d, "one", {
          type: "run_workflow",
          workflowId: "feature-split",
          params: { feature: "x" },
        });
        await d.waitFor(stepUpdate("review", "waiting"), "gate waiting");
      },
      { setup },
    );
    expect(code).toBe(0);
    expect(lines.some(terminal("failed"))).toBe(true);
  });
});
