/**
 * [#267] 后台子 Agent 的寿命上限与一次续命（手动时钟；脚本化供应商）。
 */

import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { manualTimers } from "../../test/helpers/manual-timers.js";
import { AgentCatalog } from "../agents/catalog.js";
import type { ToolResultMessage } from "../ai/types.js";
import { createSubagentExtension, subagentEnvironment } from "../cli/compose-agents.js";
import type { ComposeExtensionDeps } from "../cli/compose-extensions.js";
import type { ToolDefinition } from "../tools/types.js";
import { createRemindersExtension, REMINDER_CUSTOM_TYPE } from "./reminders.js";
import { MAX_TIMER_MS } from "../tools/timers.js";
import { DEFAULT_SUBAGENT_BACKGROUND_MAX_MS, expiredTaskText } from "./subagent-lifetime.js";
import type { SubagentEnvironment } from "./subagent-registry.js";
import type { ScriptCall, ScriptStep } from "./testing/scripted-api.js";
import { stubTool } from "./testing/stubs.js";
import {
  isChild,
  lastIsToolResult,
  subagentHarness,
  userTexts,
  waitUntil,
} from "./testing/subagent-harness.js";
import type { SessionEvent } from "./types.js";

type H = ReturnType<typeof subagentHarness>;

const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);
const results = (h: H) =>
  h.session.messages.flatMap((m) => (m.role === "toolResult" ? [m as ToolResultMessage] : []));
const notes = (h: H) =>
  h.session.messages.filter(
    (m) =>
      m.role === "user" &&
      typeof m.content === "string" &&
      m.content.startsWith("<task-notification"),
  );
const reminders = (h: H) =>
  h.session.entries.flatMap((e) =>
    e.type === "custom_message" && e.customType === REMINDER_CUSTOM_TYPE ? [String(e.content)] : [],
  );
const lastUser = (call: ScriptCall) => userTexts(call.context).at(-1) ?? "";

/** 子会话里的闸门工具：开闸（或中止）前一直等。 */
function gate(): { tool: ToolDefinition; open(): void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const tool = stubTool({
    name: "gate",
    run: async (_input, ctx) => {
      if (ctx.signal.aborted) return { content: "aborted", isError: true };
      await Promise.race([
        opened,
        new Promise<void>((resolve) =>
          ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      return { content: ctx.signal.aborted ? "aborted" : "opened" };
    },
  }) as ToolDefinition;
  return { tool, open };
}

/** 子会话：先过闸再回报；父会话按最后一条 user 文本选动作。 */
function script(parent: Record<string, ScriptStep>) {
  return (call: ScriptCall): ScriptStep => {
    if (isChild(call)) {
      if (!lastIsToolResult(call)) return { toolCalls: [{ name: "gate", args: {} }] };
      return { text: `report ${userTexts(call.context)[0] ?? ""}` };
    }
    if (lastIsToolResult(call)) return { text: "parent done" };
    return parent[lastUser(call)] ?? { text: `ack ${lastUser(call)}` };
  };
}

/** 注册表 + 提醒通道一起装（subagentHarness 的 extensions 被这里覆盖）。 */
function harness(
  env: Partial<SubagentEnvironment>,
  parent: Record<string, ScriptStep>,
  g = gate(),
) {
  const environment: SubagentEnvironment = { catalog: new AgentCatalog(), ...env };
  const h = subagentHarness({
    extraTools: [g.tool],
    env,
    script: script(parent),
    extensions: [
      ({ core }) => (core.depth > 0 ? undefined : createSubagentExtension(core, environment)),
      ({ core }) => createRemindersExtension(core),
    ],
  });
  return { h, g };
}

async function say(h: H, text: string): Promise<void> {
  await h.session.waitForIdle();
  await h.session.prompt(text, { streamingBehavior: "followUp" });
  await h.session.waitForIdle();
}

const task = (args: Record<string, unknown>): ScriptStep => ({
  toolCalls: [{ name: "task", args }],
});
const ctl = (args: Record<string, unknown>): ScriptStep => ({
  toolCalls: [{ name: "task_ctl", args }],
});

describe("后台子 Agent 的寿命上限", () => {
  it("后台任务到点按 stop 处理（aborted，不发 task-notification），下次提示前经提醒通道告知一次", async () => {
    const timers = manualTimers();
    const { h } = harness(
      { backgroundMaxMs: 3_600_000, timers },
      { go: task({ prompt: "slow", background: true }), next: { text: "ack next" } },
    );
    await h.session.prompt("go");
    await waitUntil(() => of(h.events, "subagent_start").length === 1);
    expect(timers.pending()).toEqual([{ ms: 3_600_000 }]);
    timers.fire(0);
    await waitUntil(() => of(h.events, "subagent_end").length === 1);
    expect(of(h.events, "subagent_end")[0]).toMatchObject({ taskId: "t1", status: "aborted" });
    await say(h, "next");
    expect(notes(h)).toHaveLength(0);
    const lines = reminders(h);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      "Background task t1 (agent general) was stopped at its lifetime cap (60 min, subagents.backgroundMaxMs); output so far: ",
    );
    expect(lines[0]).toContain("(task_ctl output)");
    await say(h, "again");
    expect(reminders(h)).toHaveLength(1); // 只报一次
    await h.session.dispose();
  });

  it("到点后续聊重启的任务：expired 清掉，正常结束不再误报寿命上限；超大上限钳到 2^31−1", async () => {
    const timers = manualTimers();
    const { h, g } = harness(
      { backgroundMaxMs: MAX_TIMER_MS * 4, timers },
      {
        go: task({ prompt: "slow", background: true }),
      },
    );
    await h.session.prompt("go");
    await waitUntil(() => of(h.events, "subagent_start").length === 1);
    expect(timers.pending()).toEqual([{ ms: MAX_TIMER_MS }]);
    timers.fire(0);
    await waitUntil(() => of(h.events, "subagent_end").length === 1);
    // 提醒还没取走就续聊重启（宿主 / 视图直接续聊，不经过提示）：报告的是上一次运行，不等这次结束
    g.open();
    await h.session.spawnSubagent({
      taskId: "t1",
      prompt: "continue",
      background: true,
      parentToolCallId: "host",
      signal: new AbortController().signal,
    });
    await say(h, "next");
    expect(reminders(h)).toHaveLength(1);
    expect(reminders(h)[0]).toContain("stopped at its lifetime cap");
    // [#278] 被 stop 过的 ama 子会话续聊后正常完成：completed；不再出第二条寿命提醒
    await waitUntil(() => of(h.events, "subagent_end").length === 2);
    expect(of(h.events, "subagent_end")[1]).toMatchObject({ taskId: "t1", status: "completed" });
    await say(h, "after");
    expect(reminders(h)).toHaveLength(1);
    await h.session.dispose();
  });

  it("task_ctl extend：续命一次（增量封顶一个上限），再续被拒；到点前结束的任务清掉计时器", async () => {
    const timers = manualTimers();
    const { h, g } = harness(
      { backgroundMaxMs: 600_000, timers },
      {
        go: task({ prompt: "work", background: true }),
        extend: ctl({ action: "extend", taskId: "t1", timeoutMs: 3_600_000 }),
        again: ctl({ action: "extend", taskId: "t1" }),
      },
    );
    await h.session.prompt("go");
    await waitUntil(() => of(h.events, "subagent_start").length === 1);
    await say(h, "extend");
    expect(String(results(h)[1]?.content)).toBe(
      "Task t1 lifetime extended by 10 min; it is now stopped after 20 min in total and cannot be extended again.",
    );
    expect(results(h)[1]?.isError).toBe(false);
    expect(timers.pending()).toHaveLength(1);
    await say(h, "again");
    expect(String(results(h)[2]?.content)).toBe(
      "Task t1 was already extended once; it cannot be extended again.",
    );
    expect(results(h)[2]?.isError).toBe(true);
    g.open();
    await waitUntil(() => notes(h).length === 1);
    expect(timers.pending()).toEqual([]);
    expect(reminders(h)).toEqual([]);
    await h.session.dispose();
  });

  it("backgroundMaxMs 0 = 不限：不起计时器，extend 说明没有上限；前台任务不计寿命", async () => {
    const timers = manualTimers();
    const { h, g } = harness(
      { backgroundMaxMs: 0, timers },
      {
        go: task({ prompt: "free", background: true }),
        extend: ctl({ action: "extend", taskId: "t1" }),
      },
    );
    await h.session.prompt("go");
    await waitUntil(() => of(h.events, "subagent_start").length === 1);
    expect(timers.delays).toEqual([]);
    await say(h, "extend");
    expect(String(results(h)[1]?.content)).toBe("Task t1 has no lifetime cap; nothing to extend.");
    g.open();
    await waitUntil(() => notes(h).length === 1);
    await h.session.dispose();
  });

  it("前台任务转后台：寿命从转换时刻起算（转换前不起计时器）", async () => {
    const timers = manualTimers();
    const { h } = harness(
      { backgroundMaxMs: 1_800_000, timers },
      { go: task({ prompt: "fg", background: false }), hang: { kind: "hang" } },
    );
    const run = h.session.prompt("go");
    await waitUntil(() => of(h.events, "subagent_start").length === 1);
    expect(timers.delays).toEqual([]);
    expect(h.session.backgroundTask(undefined, "user")).toEqual(["t1"]);
    await run;
    expect(timers.pending()).toEqual([{ ms: 1_800_000 }]);
    timers.fire(0);
    await waitUntil(() => of(h.events, "subagent_end").length === 1);
    expect(of(h.events, "subagent_end")[0]).toMatchObject({ status: "aborted" });
    await say(h, "next");
    expect(reminders(h)[0]).toContain("stopped at its lifetime cap (30 min");
    await h.session.dispose();
  });

  it("组装：subagents.backgroundMaxMs 不设时缺省 1 小时，0 透传为不限", () => {
    const env = (subagents: Record<string, unknown> | undefined) =>
      subagentEnvironment(
        {
          assembly: { config: subagents === undefined ? {} : { subagents }, unattended: false },
        } as unknown as ComposeExtensionDeps,
        new AgentCatalog(),
      );
    expect(env(undefined).backgroundMaxMs).toBe(DEFAULT_SUBAGENT_BACKGROUND_MAX_MS);
    expect(env({ backgroundMaxMs: 0 }).backgroundMaxMs).toBe(0);
    expect(env({ backgroundMaxMs: 120_000 }).backgroundMaxMs).toBe(120_000);
  });

  it("提醒文案：没有输出文件时指向 task_ctl output", () => {
    expect(expiredTaskText({ taskId: "t2", agent: "explore", maxMs: 90_000 })).toBe(
      "Background task t2 (agent explore) was stopped at its lifetime cap (1.5 min, subagents.backgroundMaxMs); task_ctl output has what it produced.",
    );
  });
});

describe("[#278] 停止过的子会话续聊：每次运行自己的中止信号", () => {
  const ends = (h: H) => of(h.events, "subagent_end").map((e) => e.status);

  it("task_ctl stop 之后续聊、正常完成：completed，并发 task-notification", async () => {
    const timers = manualTimers();
    const { h, g } = harness(
      { backgroundMaxMs: 0, timers },
      {
        go: task({ prompt: "slow", background: true }),
        stop: ctl({ action: "stop", taskId: "t1" }),
        again: task({ prompt: "continue", taskId: "t1", background: true }),
      },
    );
    await h.session.prompt("go");
    await waitUntil(() => of(h.events, "subagent_start").length === 1);
    await say(h, "stop");
    expect(ends(h)).toEqual(["aborted"]);
    g.open();
    await say(h, "again");
    await waitUntil(() => ends(h).length === 2);
    expect(ends(h)).toEqual(["aborted", "completed"]);
    await waitUntil(() => notes(h).length === 1);
    const note = notes(h)[0];
    expect(note?.role === "user" ? String(note.content) : "").toContain("report slow");
    await h.session.dispose();
  });

  it("续聊过程中再 stop：这一次 aborted；之后再续聊仍能正常完成", async () => {
    const timers = manualTimers();
    const { h, g } = harness(
      { backgroundMaxMs: 0, timers },
      {
        go: task({ prompt: "slow", background: true }),
        stop: ctl({ action: "stop", taskId: "t1" }),
        again: task({ prompt: "continue", taskId: "t1", background: true }),
      },
    );
    await h.session.prompt("go");
    await waitUntil(() => of(h.events, "subagent_start").length === 1);
    await say(h, "stop");
    await say(h, "again");
    await waitUntil(() => of(h.events, "subagent_start").length === 2);
    await say(h, "stop");
    expect(ends(h)).toEqual(["aborted", "aborted"]);
    g.open();
    await say(h, "again");
    await waitUntil(() => ends(h).length === 3);
    expect(ends(h)).toEqual(["aborted", "aborted", "completed"]);
    await h.session.dispose();
  });

  it("前台续聊时父信号中止：子任务 aborted（父中止仍经注册表的 controller 传到子会话）", async () => {
    const timers = manualTimers();
    const { h } = harness(
      { backgroundMaxMs: 0, timers },
      {
        go: task({ prompt: "slow", background: true }),
        stop: ctl({ action: "stop", taskId: "t1" }),
      },
    );
    await h.session.prompt("go");
    await waitUntil(() => of(h.events, "subagent_start").length === 1);
    await say(h, "stop");
    const parent = new AbortController();
    const running = h.session.spawnSubagent({
      taskId: "t1",
      prompt: "continue",
      background: false,
      parentToolCallId: "host",
      signal: parent.signal,
    });
    await waitUntil(() => of(h.events, "subagent_start").length === 2);
    parent.abort();
    expect((await running).status).toBe("aborted");
    expect(ends(h)).toEqual(["aborted", "aborted"]);
    await h.session.dispose();
  });

  it("同一父信号上多次前台续聊：结束后不残留 abort 监听器，寿命计时器也不残留", async () => {
    const timers = manualTimers();
    const { h, g } = harness({ backgroundMaxMs: 600_000, timers }, {});
    g.open();
    const parent = new AbortController();
    const spawn = (taskId?: string) =>
      h.session.spawnSubagent({
        ...(taskId === undefined ? {} : { taskId }),
        prompt: "go",
        background: false,
        parentToolCallId: "host",
        signal: parent.signal,
      });
    expect((await spawn()).status).toBe("completed");
    expect((await spawn("t1")).status).toBe("completed");
    expect((await spawn("t1")).status).toBe("completed");
    expect(ends(h)).toEqual(["completed", "completed", "completed"]);
    expect(getEventListeners(parent.signal, "abort")).toEqual([]);
    expect(timers.pending()).toEqual([]);
    await h.session.dispose();
  });
});
