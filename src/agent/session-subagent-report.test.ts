/**
 * 子 Agent 的结构化报告端到端（#269）：子会话调用 `report` → 父的 task 结果 / 通知 / 事件 / TaskInfo。
 * 工具表与父逐字节一致、父会话被拒、单槽三态、续聊清槽、没有报告时逐字节不变、fork 与内层调用。
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import type { ToolResultMessage } from "../ai/types.js";
import { HUMAN_ACTION_RULE, REPORT_ROLE_HINT } from "../agents/report.js";
import { REPORT_PARENT_REJECTION } from "../tools/report.js";
import { sessionDirForCwd } from "../session/store.js";
import type { ToolDefinition } from "../tools/types.js";
import { registryOf } from "./subagent-registry.js";
import type { ScriptCall, ScriptStep } from "./testing/scripted-api.js";
import { stubTool } from "./testing/stubs.js";
import {
  agentDef,
  isChild,
  lastIsToolResult,
  subagentHarness,
  userTexts,
  waitUntil,
} from "./testing/subagent-harness.js";
import type { SessionEvent } from "./types.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function dir(): string {
  home = createTmpHome("ama-269-");
  return sessionDirForCwd(home.dataDir, home.cwd);
}

type H = ReturnType<typeof subagentHarness>;
const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);
const results = (h: H) =>
  h.session.messages.flatMap((m) => (m.role === "toolResult" ? [m as ToolResultMessage] : []));
const notes = (h: H) =>
  h.session.messages.flatMap((m) =>
    m.role === "user" && typeof m.content === "string" && m.content.startsWith("<task-notification")
      ? [m]
      : [],
  );
const toolsOf = (call: ScriptCall): string =>
  JSON.stringify((call.context.messages[0] as { toolsAdded?: unknown }).toolsAdded);
/** 最后一条 user 消息之后的工具结果数（续聊与 fork 的上下文里有更早的结果）。 */
const seen = (call: ScriptCall): number => {
  const messages = call.context.messages;
  const lastUserAt = messages.map((m) => m.role).lastIndexOf("user");
  return messages.slice(lastUserAt + 1).filter((m) => m.role === "toolResult").length;
};
const lastUser = (call: ScriptCall) => userTexts(call.context).at(-1) ?? "";
const FORK_MARK = "<task>\nYou are a sub-agent forked from the conversation above";
const isFork = (call: ScriptCall): boolean =>
  userTexts(call.context).some((text) => text.startsWith(FORK_MARK));

const report = (args: Record<string, unknown>) => ({ name: "report", args });
const task = (args: Record<string, unknown>): ScriptStep => ({
  toolCalls: [{ name: "task", args }],
});

/** 子会话按已看到的工具结果数依次执行 `steps`，然后回 `final`。 */
function childSteps(steps: { name: string; args: Record<string, unknown> }[][], final: string) {
  return (call: ScriptCall): ScriptStep => {
    const step = steps[seen(call)];
    return step === undefined ? { text: final } : { toolCalls: step };
  };
}

describe("[#269] report：可见性与工具表", () => {
  it("子会话能用 report，工具表与父逐字节相同；父会话调用被拒；角色说明带报告提示", async () => {
    const h = subagentHarness({
      script: (call) => {
        if (isChild(call))
          return childSteps(
            [[report({ state: "ready", summary: "Looked at two files." })]],
            "explored",
          )(call);
        if (seen(call) === 0) return { toolCalls: [report({ state: "ready", summary: "x" })] };
        if (seen(call) === 1) return task({ prompt: "look", agent: "explore" });
        return { text: "parent done" };
      },
    });
    await h.session.prompt("go");
    const [parent, child] = [h.scripted.calls[0]!, h.scripted.calls.find(isChild)!];
    expect(toolsOf(child)).toBe(toolsOf(parent));
    expect(toolsOf(child)).toContain('"name":"report"');
    const system = child.context.messages[0] as { sections?: Record<string, string> };
    expect(system.sections?.["role"]).toContain(REPORT_ROLE_HINT);
    const [parentReport, taskResult] = results(h);
    expect(parentReport).toMatchObject({ toolName: "report", isError: true });
    expect(String(parentReport?.content)).toBe(REPORT_PARENT_REJECTION);
    // 子会话里的 report 不被拒，结果说明记了什么
    const childResults = h.scripted.calls
      .filter(isChild)
      .at(-1)!
      .context.messages.filter((m) => m.role === "toolResult");
    expect(childResults[0]).toMatchObject({ toolName: "report", isError: false });
    expect(String(childResults[0]?.content)).toBe("Recorded: ready — Looked at two files.");
    expect(String(taskResult?.content)).toBe(
      "[task t1] [report] ready · Looked at two files.\n\nexplored",
    );
    expect(taskResult?.details).toMatchObject({
      report: { state: "ready", summary: "Looked at two files." },
      status: "completed",
    });
    const updates = of(h.events, "subagent_update").filter((e) => e.kind === "report");
    expect(updates).toEqual([
      {
        type: "subagent_update",
        taskId: "t1",
        kind: "report",
        turn: 0,
        report: { state: "ready", summary: "Looked at two files." },
      },
    ]);
    expect(of(h.events, "subagent_end")[0]).toMatchObject({
      taskId: "t1",
      status: "completed",
      report: { state: "ready", summary: "Looked at two files." },
    });
    expect(registryOf(h.manager.id)?.get("t1")?.report).toEqual({
      state: "ready",
      summary: "Looked at two files.",
    });
  });

  it("类型白名单去不掉 report；只读类型（plan 模式）也能报告", async () => {
    const h = subagentHarness({
      env: {
        catalog: new (await import("../agents/catalog.js")).AgentCatalog([
          agentDef("narrow", { tools: ["read"], permissionMode: "plan" }),
        ]),
      },
      script: (call) => {
        if (isChild(call))
          return childSteps(
            [[report({ state: "failed", summary: "Nothing to read." })]],
            "none",
          )(call);
        return lastIsToolResult(call)
          ? { text: "parent done" }
          : task({ prompt: "x", agent: "narrow" });
      },
    });
    await h.session.prompt("go");
    const child = h.scripted.calls.find(isChild)!;
    const names = (JSON.parse(toolsOf(child)) as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["read", "report"]);
    expect(String(results(h)[0]?.content)).toBe(
      "[task t1] [report] failed · Nothing to read.\n\nnone",
    );
  });

  it("没有调用 report 时结果、事件与 TaskInfo 与原来相同", async () => {
    const h = subagentHarness({
      script: (call) => {
        if (isChild(call)) return { text: "plain" };
        return lastIsToolResult(call) ? { text: "parent done" } : task({ prompt: "x" });
      },
    });
    await h.session.prompt("go");
    expect(String(results(h)[0]?.content)).toBe("[task t1] plain");
    expect(results(h)[0]?.details).not.toHaveProperty("report");
    expect(of(h.events, "subagent_update").some((e) => e.kind === "report")).toBe(false);
    expect(of(h.events, "subagent_end")[0]).not.toHaveProperty("report");
    expect(registryOf(h.manager.id)?.get("t1")).not.toHaveProperty("report");
  });
});

describe("[#269] report：单槽、续聊与后台", () => {
  it("一次运行内：给出替换、省略保持、null 清空；结果取折叠后的值", async () => {
    const h = subagentHarness({
      script: (call) => {
        if (isChild(call))
          return childSteps(
            [
              [
                report({
                  state: "blocked",
                  summary: "Need an account.",
                  humanAction: "Which account?",
                }),
              ],
              [report({ state: "waiting", summary: "Still waiting." })],
              [
                report({
                  state: "blocked",
                  summary: "Two things.",
                  humanAction: "Staging or prod?",
                }),
              ],
            ],
            "stopped here",
          )(call);
        return lastIsToolResult(call) ? { text: "parent done" } : task({ prompt: "x" });
      },
    });
    await h.session.prompt("go");
    const updates = of(h.events, "subagent_update")
      .filter((e) => e.kind === "report")
      .map((e) => e.report);
    expect(updates).toEqual([
      { state: "blocked", summary: "Need an account.", humanAction: "Which account?" },
      { state: "waiting", summary: "Still waiting.", humanAction: "Which account?" },
      { state: "blocked", summary: "Two things.", humanAction: "Staging or prod?" },
    ]);
    expect(String(results(h)[0]?.content)).toBe(
      [
        "[task t1] [report] blocked · Two things.",
        "[needs a person] Staging or prod?",
        HUMAN_ACTION_RULE,
        "",
        "stopped here",
      ].join("\n"),
    );
  });

  it("null 清空后结果里没有 [needs a person]", async () => {
    const h = subagentHarness({
      script: (call) => {
        if (isChild(call))
          return childSteps(
            [
              [
                report({
                  state: "blocked",
                  summary: "Need an account.",
                  humanAction: "Which account?",
                }),
              ],
              [report({ state: "ready", summary: "Used the default.", humanAction: null })],
            ],
            "done",
          )(call);
        return lastIsToolResult(call) ? { text: "parent done" } : task({ prompt: "x" });
      },
    });
    await h.session.prompt("go");
    expect(String(results(h)[0]?.content)).toBe(
      "[task t1] [report] ready · Used the default.\n\ndone",
    );
    expect(results(h)[0]?.details).toMatchObject({
      report: { state: "ready", summary: "Used the default." },
    });
  });

  it("续聊是新的运行：上一次的问题不保留；没有报告的运行清掉 TaskInfo.report", async () => {
    const h = subagentHarness({
      dir: dir(),
      script: (call) => {
        if (isChild(call)) {
          const prompts = userTexts(call.context).length;
          if (prompts === 1)
            return childSteps(
              [[report({ state: "waiting", summary: "Need the account.", humanAction: "Which?" })]],
              "waiting",
            )(call);
          if (prompts === 2)
            return childSteps(
              [[report({ state: "ready", summary: "Done with it." })]],
              "done",
            )(call);
          return { text: "plain follow-up" };
        }
        if (lastIsToolResult(call)) return { text: "parent done" };
        switch (lastUser(call)) {
          case "one":
            return task({ prompt: "first" });
          case "two":
            return task({ prompt: "use account A", taskId: "t1" });
          default:
            return task({ prompt: "anything else?", taskId: "t1" });
        }
      },
    });
    await h.session.prompt("one");
    expect(String(results(h)[0]?.content)).toContain("[needs a person] Which?");
    await h.session.prompt("two");
    expect(String(results(h)[1]?.content)).toBe("[task t1] [report] ready · Done with it.\n\ndone");
    expect(registryOf(h.manager.id)?.get("t1")?.report).toEqual({
      state: "ready",
      summary: "Done with it.",
    });
    await h.session.prompt("three");
    expect(String(results(h)[2]?.content)).toBe("[task t1] plain follow-up");
    expect(registryOf(h.manager.id)?.get("t1")).not.toHaveProperty("report");
    // 父会话快照：最后一条 ama.task 没有 report
    const snapshots = h.manager
      .branch()
      .filter((e) => e.type === "custom" && e.customType === "ama.task")
      .map((e) => (e.type === "custom" ? (e.data as { report?: unknown }).report : undefined));
    expect(snapshots.at(-1)).toBeUndefined();
    expect(snapshots.some((r) => r !== undefined)).toBe(true);
  });

  it("后台任务：<task-notification> 带 report 属性，正文前有报告行与规则句", async () => {
    const h = subagentHarness({
      script: (call) => {
        if (isChild(call))
          return childSteps(
            [[report({ state: "blocked", summary: "Need a decision.", humanAction: "Ship it?" })]],
            "report work",
          )(call);
        if (lastUser(call).startsWith("<task-notification")) return { text: "relayed" };
        return lastIsToolResult(call)
          ? { text: "started" }
          : task({ prompt: "x", background: true });
      },
    });
    await h.session.prompt("go");
    await waitUntil(() => notes(h).length === 1);
    await h.session.waitForIdle();
    const note = String(notes(h)[0]?.content);
    expect(note).toMatch(
      /^<task-notification taskId="t1" agent="general" status="completed"[^>]* report="blocked">/,
    );
    expect(note).toContain(
      `\n[report] blocked · Need a decision.\n[needs a person] Ship it?\n${HUMAN_ACTION_RULE}\n\nreport work\n</task-notification>`,
    );
    expect(of(h.events, "subagent_end")[0]).toMatchObject({
      report: { state: "blocked", summary: "Need a decision.", humanAction: "Ship it?" },
    });
    await h.session.dispose();
  });
});

describe("[#269] report：fork 与内层调用", () => {
  it("fork 子会话也能报告（<task> 末尾有提示，工具表仍与父相同）", async () => {
    const h = subagentHarness({
      dir: dir(),
      script: (call) => {
        if (isFork(call))
          return childSteps(
            [[report({ state: "ready", summary: "Forked and done." })]],
            "child report",
          )(call);
        if (lastUser(call) === "hello") return { text: "hi" };
        if (lastIsToolResult(call)) return { text: "parent done" };
        return task({ prompt: "do it", context: "fork" });
      },
    });
    await h.session.prompt("hello");
    await h.session.prompt("go");
    const fork = h.scripted.calls.find(isFork)!;
    expect(userTexts(fork.context).at(-1)).toContain(REPORT_ROLE_HINT);
    expect(toolsOf(fork)).toBe(toolsOf(h.scripted.calls[0]!));
    const result = results(h).at(-1)!;
    expect(String(result.content)).toBe(
      "[task t1] [report] ready · Forked and done.\n\nchild report",
    );
    expect(result.details).toMatchObject({ context: "fork", report: { state: "ready" } });
  });

  it("经另一个工具嵌套调用 report（codemode 内层）同样折叠", async () => {
    const wrap = stubTool({
      name: "wrap",
      run: async (_input, ctx) =>
        ctx.tools.executeTool("report", { state: "waiting", summary: "Via script." }),
    }) as ToolDefinition;
    const h = subagentHarness({
      extraTools: [wrap],
      script: (call) => {
        if (isChild(call)) return childSteps([[{ name: "wrap", args: {} }]], "scripted")(call);
        return lastIsToolResult(call) ? { text: "parent done" } : task({ prompt: "x" });
      },
    });
    await h.session.prompt("go");
    expect(String(results(h)[0]?.content)).toBe(
      "[task t1] [report] waiting · Via script.\n\nscripted",
    );
  });
});
