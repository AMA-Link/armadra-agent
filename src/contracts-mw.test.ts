/**
 * 多 Agent 工作流契约的编译期与桩断言（多 Agent 工作流设计稿 §5；[#316 #317 #318]）。
 * 全部是可选字段或新增类型：旧代码不必改动就能编译；改契约时先改这里。
 */

import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { AmaError } from "./errors.js";
import type { TierName } from "./agents/tier-ladder.js";
import { TYPICAL_TASK_TOKENS } from "./agents/tier-cost.js";
import type {
  SubagentRequest,
  SubagentRunRequest,
  TaskInfo,
  ToolAnnotations,
} from "./tools/types.js";
import type {
  SubagentEndEvent,
  SubagentStartEvent,
  WorkflowUpdateEvent,
} from "./agent/types-w5.js";
import type { SessionEventW5 } from "./agent/types-w5.js";
import type { AcpAmaMeta } from "./drivers/acp/types.js";
import type { AgentEvents, HostApi, RunnerDoneEvent } from "./host/types.js";
import { HOST_API_MINOR } from "./host/types.js";
import type { AmaConfigW5, ModelsConfig } from "./config/types-w5.js";
import { WORKFLOW_UNATTENDED_GATES } from "./config/types-w5.js";
import { CATALOGS } from "./i18n/catalog.js";
import { WORKFLOW_FORMAT_VERSION } from "./workflows/types.js";
import {
  WORKFLOW_CUSTOM_TYPE,
  WORKFLOW_ERROR_CODES,
  type WorkflowUpdate,
} from "./workflows/run-types.js";
import {
  discoverWorkflows,
  userWorkflowDir,
  workflowFileHash,
  workflowSources,
  workflowTargetPath,
} from "./workflows/discover.js";
import { workflowFromTasks } from "./workflows/from-tasks.js";
import { runOnHost } from "./workflows/host-handoff.js";
import { activeWorkflow, startWorkflow, workflowHostOf } from "./workflows/runner.js";
import { createWorkflowsFactory } from "./cli/compose-workflows.js";

describe("契约：类型与常量", () => {
  it("HOST_API_MINOR 仍是 4（改成 5 归 M12）", () => {
    expect(HOST_API_MINOR).toBe(4);
  });

  it("新增字段全部可选", () => {
    expectTypeOf<ToolAnnotations["alwaysAsk"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<SubagentRequest["tier"]>().toEqualTypeOf<TierName | undefined>();
    expectTypeOf<SubagentRequest["readOnly"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<SubagentRunRequest["depth"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<TaskInfo["tier"]>().toEqualTypeOf<TierName | undefined>();
    expectTypeOf<SubagentStartEvent["parentTaskId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SubagentEndEvent["costUsd"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<RunnerDoneEvent["depth"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<AcpAmaMeta["workflow"]>().not.toBeNever();
    expectTypeOf<ModelsConfig["tiers"]>().not.toBeNever();
    expectTypeOf<AmaConfigW5["workflows"]>().not.toBeNever();
    expectTypeOf<HostApi["workflows"]>().not.toBeNever();
    expectTypeOf<AgentEvents["workflow_update"]>().toEqualTypeOf<
      Omit<WorkflowUpdateEvent, "type">
    >();
    expectTypeOf<
      Extract<SessionEventW5, { type: "workflow_update" }>
    >().toEqualTypeOf<WorkflowUpdateEvent>();
    expectTypeOf<WorkflowUpdateEvent>().toMatchTypeOf<WorkflowUpdate>();
  });

  it("常量", () => {
    expect(WORKFLOW_FORMAT_VERSION).toBe(2);
    expect(WORKFLOW_CUSTOM_TYPE).toBe("ama.workflow");
    expect(WORKFLOW_UNATTENDED_GATES).toEqual(["reject", "approve"]);
    expect(WORKFLOW_ERROR_CODES).toContain("workflow_handler_exists");
    expect(TYPICAL_TASK_TOKENS).toEqual({ input: 150_000, output: 15_000 });
  });

  it("types.ts 只 import 类型", () => {
    const source = readFileSync(new URL("./workflows/types.ts", import.meta.url), "utf8");
    const imports = source.match(/^import .*$/gm) ?? [];
    expect(imports.every((line) => line.startsWith("import type "))).toBe(true);
  });
});

describe("契约：桩抛 not_implemented", () => {
  const calls: [string, () => unknown][] = [
    ["userWorkflowDir", () => userWorkflowDir("")],
    ["workflowSources", () => workflowSources({ cwd: "", configDir: "" })],
    ["discoverWorkflows", () => discoverWorkflows([], { trusted: true })],
    ["workflowTargetPath", () => workflowTargetPath("user", "x", { cwd: "", configDir: "" })],
    ["workflowFileHash", () => workflowFileHash("")],
    ["workflowFromTasks", () => workflowFromTasks([], new Map(), "")],
    ["runOnHost", () => runOnHost(undefined as never, undefined as never, undefined as never, {})],
    ["startWorkflow", () => startWorkflow(undefined as never, undefined as never, {})],
    ["workflowHostOf", () => workflowHostOf(undefined as never)],
    ["activeWorkflow", () => activeWorkflow("s")],
  ];
  for (const [name, call] of calls) {
    it(name, () => {
      let error: unknown;
      try {
        call();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AmaError);
      expect((error as AmaError).code).toBe("not_implemented");
      expect((error as AmaError).message).toBe(`${name} is not implemented yet`);
    });
  }

  it("createWorkflowsFactory 的桩什么都不装", () => {
    expect(createWorkflowsFactory(undefined as never)(undefined as never)).toBeUndefined();
  });
});

describe("契约：i18n 域", () => {
  it("workflows 域在两种语言里都登记", () => {
    expect(CATALOGS.en.workflows.usage).toContain("/workflow");
    expect(CATALOGS.zh.workflows.run.busy).not.toBe(CATALOGS.en.workflows.run.busy);
    expect(CATALOGS.en.workflows.list.line("a", "T", 1, "user")).toBe("a — T (1 step, user)");
    expect(CATALOGS.en.workflows.preview.role("r", "m", "light")).toBe("r: m · light");
    expect(CATALOGS.en.workflows.preview.role("r", "m")).toBe("r: m");
  });
});
