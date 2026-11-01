import { describe, expect, it } from "vitest";
import { AgentCatalog } from "../agents/catalog.js";
import { createSubagentsFactory, subagentEnvironment } from "./compose-agents.js";
import { NO_AGENT_PROBE_ENV } from "../agents/external.js";
import { COORDINATOR_WAIT_MAX_MS, createTaskCtlTool } from "../tools/task-ctl.js";
import { createTaskTool } from "../tools/task.js";
import {
  registerTaskControl,
  unregisterTaskControl,
  type TaskControl,
} from "../agents/task-control.js";
import { makeToolContext } from "../../test/helpers/tool-context.js";
import type { ToolDefinition } from "../tools/types.js";
import type { ComposeExtensionDeps } from "./compose-extensions.js";

const env = (subagents?: Record<string, unknown>) =>
  subagentEnvironment(
    {
      assembly: { config: subagents === undefined ? {} : { subagents }, unattended: false },
    } as unknown as ComposeExtensionDeps,
    new AgentCatalog(),
  );

describe("[M-F] subagents.retainSessions", () => {
  it("配置写进注册表环境的 retain；未配置时不写（注册表用缺省 4）", () => {
    expect(env().retain).toBeUndefined();
    expect(env({ retainSessions: 0 }).retain).toBe(0);
    expect(env({ retainSessions: 8 }).retain).toBe(8);
  });
});

describe("[#242] coordinator 预设不阻塞", () => {
  const withPreset = (preset: string | undefined, subagents?: Record<string, unknown>) =>
    subagentEnvironment(
      {
        assembly: {
          config: {
            ...(preset === undefined ? {} : { tools: { preset } }),
            ...(subagents === undefined ? {} : { subagents }),
          },
          unattended: true,
        },
      } as unknown as ComposeExtensionDeps,
      new AgentCatalog(),
    );

  it("task 缺省后台：-p（unattended）与 subagents.background: never 都不改", () => {
    expect(withPreset("coordinator").background).toBe(true);
    expect(withPreset("coordinator", { background: "never" }).background).toBe(true);
  });

  it("其它预设不变：-p 前台，never 前台，always 后台", () => {
    for (const preset of [undefined, "default", "minimal", "codemode-only"]) {
      expect(withPreset(preset).background).toBe(false);
      expect(withPreset(preset, { background: "never" }).background).toBe(false);
      expect(withPreset(preset, { background: "always" }).background).toBe(true);
    }
  });

  /** 装配 task / task_ctl（`-p`，缺省前台）并返回 wait 实际收到的超时与 task 描述。 */
  async function waitedMs(preset: string | undefined): Promise<{ ms: number; task: string }> {
    const task = createTaskTool() as ToolDefinition;
    const ctl = createTaskCtlTool() as ToolDefinition;
    const tools = new Map([
      ["task", task],
      ["task_ctl", ctl],
    ]);
    createSubagentsFactory({
      env: { [NO_AGENT_PROBE_ENV]: "1" },
      assembly: {
        config: preset === undefined ? {} : { tools: { preset } },
        unattended: true,
        tools: { get: (name: string) => tools.get(name) },
        paths: { cwd: "/w", configDir: "/w/.cfg", dataDir: "/w/.data" },
        trust: { trusted: false },
        host: {},
        warn: () => undefined,
      },
    } as unknown as ComposeExtensionDeps);
    let ms = -1;
    const info = { taskId: "t1", agent: "general", status: "running", background: true };
    const control = {
      get: () => info,
      detachSignal: () => new AbortController().signal,
      wait: async (_id: string, timeoutMs: number) => {
        ms = timeoutMs;
        return undefined;
      },
    } as unknown as TaskControl;
    registerTaskControl("sess-test", control);
    try {
      await ctl.execute({ action: "wait", taskId: "t1", timeoutMs: 60_000 }, makeToolContext("/w"));
    } finally {
      unregisterTaskControl("sess-test", control);
    }
    return { ms, task: String(task.description) };
  }

  it("组装根：coordinator 绑定 wait 封顶与后台版 task 描述；其它预设不绑", async () => {
    const coordinator = await waitedMs("coordinator");
    expect(coordinator.ms).toBe(COORDINATOR_WAIT_MAX_MS);
    expect(coordinator.task).toContain("Runs in the background by default");
    const plain = await waitedMs("default");
    expect(plain.ms).toBe(60_000);
    expect(plain.task).not.toContain("Runs in the background by default");
    expect((await waitedMs(undefined)).ms).toBe(60_000);
  });
});
