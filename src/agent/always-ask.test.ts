/**
 * [#318] alwaysAsk 的门控兜底：不依赖会话的权限管线（宿主自带的 PermissionPipelineApi 不认这个标注、
 * 或根本没有管线），也不受 codemode 内层调用绕过。
 */

import { describe, expect, it } from "vitest";
import { sandboxEntryForTests } from "../../test/helpers/codemode-sandbox.js";
import { detectSandboxCapability } from "../codemode/capability.js";
import { createCodemodeTool } from "../codemode/tool.js";
import { PermissionPipeline } from "../permissions/pipeline.js";
import type { ApprovalRequest } from "../permissions/types.js";
import type { ToolDefinition } from "../tools/types.js";
import { createHarness } from "./testing/harness.js";
import { stubPermission, stubTool } from "./testing/stubs.js";

function saveTool(ran: string[]): ToolDefinition {
  return {
    ...stubTool({
      name: "workflow_save",
      permission: "write",
      run: async () => (ran.push("ran"), { content: "saved" }),
    }),
    annotations: { alwaysAsk: true },
  } as ToolDefinition;
}
const call = { toolCalls: [{ name: "workflow_save", args: {} }] };

describe("alwaysAsk 不依赖权限管线", () => {
  it("宿主自带的管线放行 → 仍然询问；拒绝则不执行", async () => {
    const asked: ApprovalRequest[] = [];
    const ran: string[] = [];
    const h = createHarness({
      tools: [saveTool(ran)],
      permission: stubPermission(() => ({ decision: "allow", step: "mode" })),
      brokers: [{ ask: async (r) => (asked.push(r), "deny") }],
      script: [call, { text: "done" }],
    });
    await h.session.prompt("go");
    expect(asked.map((r) => r.toolName)).toEqual(["workflow_save"]);
    expect(ran).toEqual([]);
  });

  it("没有权限管线：询问，同意才执行", async () => {
    const asked: string[] = [];
    const ran: string[] = [];
    const h = createHarness({
      tools: [saveTool(ran)],
      brokers: [{ ask: async (r) => (asked.push(r.toolName), "allow") }],
      script: [call, { text: "done" }],
    });
    await h.session.prompt("go");
    expect(asked).toEqual(["workflow_save"]);
    expect(ran).toEqual(["ran"]);
  });

  it("没有权限管线且无人值守：拒绝，不询问", async () => {
    const asked: string[] = [];
    const ran: string[] = [];
    const h = createHarness({
      tools: [saveTool(ran)],
      unattended: true,
      brokers: [{ ask: async (r) => (asked.push(r.toolName), "allow") }],
      script: [call, { text: "done" }],
    });
    await h.session.prompt("go");
    expect(asked).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("codemode 脚本里调用 workflow_save 仍询问（full-auto 下也问）", async () => {
    const asked: ApprovalRequest[] = [];
    const ran: string[] = [];
    const save = saveTool(ran);
    const codemode = createCodemodeTool({
      listTools: () => [{ tool: save, textResult: true }],
      capability: detectSandboxCapability("26.0.0"),
      entry: sandboxEntryForTests(),
    }) as ToolDefinition;
    const h = createHarness({
      tools: [codemode, save],
      activeTools: ["codemode"],
      permission: new PermissionPipeline({ mode: "full-auto", rules: [], cwd: "/work" }),
      brokers: [{ ask: async (r) => (asked.push(r), "deny") }],
      script: [
        { toolCalls: [{ name: "codemode", args: { script: "await tools.workflow_save({});" } }] },
        { text: "done" },
      ],
    });
    await h.session.prompt("go");
    expect(asked.filter((r) => r.toolName === "workflow_save")).toHaveLength(1);
    expect(ran).toEqual([]);
  });
});
