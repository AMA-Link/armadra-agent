import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeToolContext } from "../../test/helpers/tool-context.js";
import type { ToolResultMessage } from "../ai/types.js";
import type { ScriptCall, ScriptStep } from "../agent/testing/scripted-api.js";
import {
  firstUser,
  isChild,
  lastIsToolResult,
  sleepTool,
  subagentHarness,
  userTexts,
  waitUntil,
} from "../agent/testing/subagent-harness.js";
import {
  registerTaskControl,
  unregisterTaskControl,
  type TaskControl,
} from "../agents/task-control.js";
import type { TaskInfo } from "./types.js";
import {
  COORDINATOR_WAIT_MAX_MS,
  DEFAULT_WAIT_MS,
  INTERRUPTED_TASK_NOTE,
  MAX_WAIT_MS,
  bindTaskCtlWaitCap,
  createTaskCtlTool,
} from "./task-ctl.js";

const results = (h: ReturnType<typeof subagentHarness>) =>
  h.session.messages.flatMap((m) => (m.role === "toolResult" ? [m as ToolResultMessage] : []));
const lastUser = (call: ScriptCall) => userTexts(call.context).at(-1) ?? "";
/** 后台通知会在父空闲时开新回合：等空闲再说话，忙时排进 followUp。 */
async function say(h: ReturnType<typeof subagentHarness>, text: string): Promise<void> {
  await h.session.waitForIdle();
  await h.session.prompt(text, { streamingBehavior: "followUp" });
  await h.session.waitForIdle();
}
const ctl = (args: Record<string, unknown>): ScriptStep => ({
  toolCalls: [{ name: "task_ctl", args }],
});

describe("task_ctl", () => {
  it("list / output / wait 超时 / stop：运行中的后台任务", async () => {
    const parent: Record<string, ScriptStep> = {
      start: {
        toolCalls: [
          { name: "task", args: { prompt: "long", background: true, description: "dig" } },
        ],
      },
      list: ctl({ action: "list" }),
      output: ctl({ action: "output", taskId: "t1" }),
      wait: ctl({ action: "wait", taskId: "t1", timeoutMs: 10 }),
      stop: ctl({ action: "stop", taskId: "t1" }),
      unknown: ctl({ action: "wait", taskId: "t7" }),
    };
    const h = subagentHarness({
      script: (call) => {
        if (isChild(call)) return { kind: "hang", text: "half done" };
        if (lastIsToolResult(call)) return { text: "ok" };
        return parent[lastUser(call)] ?? { text: "?" };
      },
    });
    await h.session.prompt("start");
    await waitUntil(() => h.events.some((e) => e.type === "subagent_update" && e.kind === "text"));
    for (const step of ["list", "output", "wait", "stop", "list", "unknown"]) await say(h, step);
    const contents = results(h).map((r) => String(r.content));
    expect(contents[1]).toMatch(/^t1 · general · running · \d+s · background — dig$/);
    expect(contents[2]).toBe("Task t1 is running; output so far:\nhalf done");
    expect(contents[3]).toMatch(/^Task t1 is still running \(0 turns so far\)/);
    expect(contents[4]).toBe("Task t1 aborted.");
    expect(contents[5]).toMatch(/^t1 · general · aborted/);
    expect(contents[6]).toBe("Unknown task t7.");
    expect(results(h)[6]?.isError).toBe(true);
    await h.session.dispose();
  });

  it("wait 拿到最终报告；send 向已完成任务追加消息（后台）", async () => {
    const counter = { running: 0, peak: 0 };
    const parent: Record<string, ScriptStep> = {
      start: { toolCalls: [{ name: "task", args: { prompt: "job", background: true } }] },
      wait: ctl({ action: "wait", taskId: "t1", timeoutMs: 5000 }),
      send: ctl({ action: "send", taskId: "t1", prompt: "and more" }),
    };
    const h = subagentHarness({
      extraTools: [sleepTool(counter, 20)],
      script: (call) => {
        if (isChild(call)) {
          if (!lastIsToolResult(call) && userTexts(call.context).length === 1)
            return { toolCalls: [{ name: "sleep", args: {} }] };
          return {
            text: `report for ${userTexts(call.context).length} messages (${firstUser(call)})`,
          };
        }
        if (lastIsToolResult(call)) return { text: "ok" };
        return parent[lastUser(call)] ?? { text: "noted" };
      },
    });
    await h.session.prompt("start");
    await say(h, "wait");
    const waited = results(h)[1];
    expect(String(waited?.content)).toBe("[task t1 completed]\nreport for 1 messages (job)");
    await say(h, "send");
    expect(String(results(h)[2]?.content)).toMatch(/^Started background task t1/);
    await waitUntil(() =>
      h.session.messages.some(
        (m) => m.role === "user" && String(m.content).includes("report for 2 messages"),
      ),
    );
    await h.session.dispose();
  });

  it("子会话里不可用；参数校验", async () => {
    const tool = createTaskCtlTool();
    expect(
      (await tool.execute({ action: "list" }, makeToolContext("/w", { depth: 1 }))).isError,
    ).toBe(true);
    const top = makeToolContext("/w");
    expect(await tool.execute({ action: "list" }, top)).toEqual({ content: "No sub-agent tasks." });
    expect((await tool.execute({ action: "wait" }, top)).content).toBe("wait needs taskId");
    expect(tool.annotations?.pollable).toBe(true);
  });
});

describe("[#268] resume 后被打断的任务", () => {
  it("list / output / wait 对 interrupted 任务都附同一句说明", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ama-task-ctl-"));
    try {
      const first = subagentHarness({ dir, script: () => ({ text: "noop" }) });
      await first.session.prompt("warm");
      await first.session.dispose();
      const file = first.manager.file() as string;
      const crashed = subagentHarness({ file, script: () => ({ text: "noop" }) });
      crashed.manager.append({
        type: "custom",
        customType: "ama.task",
        data: {
          taskId: "t1",
          agent: "explore",
          runner: "ama",
          description: "dig",
          background: true,
          status: "running",
          startedAt: 1,
        },
      });
      await crashed.session.dispose();
      const parent: Record<string, ScriptStep> = {
        list: ctl({ action: "list" }),
        output: ctl({ action: "output", taskId: "t1" }),
        wait: ctl({ action: "wait", taskId: "t1", timeoutMs: 10 }),
      };
      const h = subagentHarness({
        file,
        script: (call) =>
          lastIsToolResult(call) ? { text: "ok" } : (parent[lastUser(call)] ?? { text: "?" }),
      });
      for (const step of ["list", "output", "wait"]) await say(h, step);
      const contents = results(h).map((r) => String(r.content));
      expect(contents[0]).toMatch(
        /^t1 · explore · interrupted · \d+s · background — dig \(it was interrupted/,
      );
      expect(contents[0]).toContain(INTERRUPTED_TASK_NOTE);
      expect(contents[1]).toBe(
        `Task t1 was interrupted (${INTERRUPTED_TASK_NOTE}); output so far:\n(no output yet)`,
      );
      expect(contents[2]).toBe(`Task t1 was interrupted (${INTERRUPTED_TASK_NOTE}).`);
      await h.session.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("task_ctl wait 封顶（#242）", () => {
  const info: TaskInfo = {
    taskId: "t1",
    agent: "general",
    runner: "ama",
    status: "running",
    description: "",
    startedAt: 0,
    background: true,
  };
  /** 假控制面：记录 wait 收到的超时，永远超时。 */
  function withControl<T>(run: (timeouts: number[]) => Promise<T>): Promise<T> {
    const timeouts: number[] = [];
    const control = {
      list: () => [info],
      get: () => info,
      wait: async (_id: string, timeoutMs: number) => {
        timeouts.push(timeoutMs);
        return undefined;
      },
      detachSignal: () => new AbortController().signal,
    } as unknown as TaskControl;
    registerTaskControl("sess-test", control);
    return run(timeouts).finally(() => unregisterTaskControl("sess-test", control));
  }
  const wait = (tool: ReturnType<typeof createTaskCtlTool>, timeoutMs?: number) =>
    tool.execute(
      { action: "wait", taskId: "t1", ...(timeoutMs === undefined ? {} : { timeoutMs }) },
      makeToolContext("/w"),
    );

  it("协调者封顶：显式大超时与缺省都只等 5 秒，回复说明被封顶；小超时不变", async () => {
    const tool = createTaskCtlTool();
    bindTaskCtlWaitCap(tool, COORDINATOR_WAIT_MAX_MS);
    await withControl(async (timeouts) => {
      const big = await wait(tool, 60_000);
      const dflt = await wait(tool);
      const small = await wait(tool, 1000);
      expect(timeouts).toEqual([5000, 5000, 1000]);
      expect(String(big.content)).toMatch(
        /^Task t1 is still running \(0 turns so far\)\..*capped at 5s/,
      );
      expect(String(dflt.content)).toContain("capped at 5s");
      expect(String(small.content)).not.toContain("capped");
    });
  });

  it("没绑定（其它预设）：缺省 30 秒、上限 600 秒，回复文案不变", async () => {
    const tool = createTaskCtlTool();
    await withControl(async (timeouts) => {
      const reply = await wait(tool, 60_000);
      await wait(tool);
      await wait(tool, MAX_WAIT_MS * 2);
      expect(timeouts).toEqual([60_000, DEFAULT_WAIT_MS, MAX_WAIT_MS]);
      expect(reply.content).toBe(
        "Task t1 is still running (0 turns so far). Wait again or stop it.",
      );
    });
  });

  it("封顶只绑在被绑定的那个工具对象上；工具描述与 schema 不变", () => {
    const capped = createTaskCtlTool();
    const plain = createTaskCtlTool();
    bindTaskCtlWaitCap(capped, COORDINATOR_WAIT_MAX_MS);
    expect(capped.description).toBe(plain.description);
    expect(capped.parameters).toEqual(plain.parameters);
  });
});
