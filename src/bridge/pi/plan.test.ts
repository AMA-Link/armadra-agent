import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeHarness, type BridgeHarness } from "../../../test/helpers/bridge-harness.js";
import type { FakePiConfig } from "../../../test/helpers/fake-pi.js";
import { setLocale } from "../../i18n/index.js";

let h: BridgeHarness | undefined;
beforeEach(() => setLocale("en"));
afterEach(async () => {
  setLocale("zh");
  // 每条线上消息都要过官方 schema：校验失败在这里抛出
  await h?.finish();
  h = undefined;
});

const CWD = process.platform === "win32" ? "C:\\work" : "/work";
const text = (t: string) => [{ type: "text" as const, text: t }];

async function open(pi: FakePiConfig) {
  h = await bridgeHarness({ pi });
  await h.client.initialize();
  const created = await h.client.newSession(CWD);
  return { h, id: created.sessionId };
}

const todoResult = (todos: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text: "ok" }],
  details: { action: "toggle", todos, nextId: 9, ...extra },
});

describe("todos → plan", () => {
  it("todo 工具每来一次结果就整表发一次 plan；类别是 think", async () => {
    const { h, id } = await open({
      onPrompt: async (t) => {
        await t.tool({
          id: "t1",
          name: "todo",
          args: { action: "add", text: "write tests" },
          result: todoResult([
            { id: 1, text: "write tests", done: false },
            { id: 2, text: "ship", done: false },
          ]),
        });
        await t.tool({
          id: "t2",
          name: "todo",
          args: { action: "toggle", id: 1 },
          result: todoResult([
            { id: 1, text: "write tests", done: true },
            { id: 2, text: "ship", done: false },
          ]),
        });
        t.assistantEnd({});
      },
    });
    await h.client.prompt(id, text("plan the work"));
    expect(h.updatesOf("plan")).toEqual([
      {
        sessionUpdate: "plan",
        entries: [
          { content: "write tests", priority: "medium", status: "pending" },
          { content: "ship", priority: "medium", status: "pending" },
        ],
      },
      {
        sessionUpdate: "plan",
        entries: [
          { content: "write tests", priority: "medium", status: "completed" },
          { content: "ship", priority: "medium", status: "pending" },
        ],
      },
    ]);
    expect(h.updatesOf("tool_call")[0]).toMatchObject({ kind: "think", name: "todo" });
  });

  it("另一种形状 {content, status, priority}；清空发空表；出错的结果和没有 todos 的结果不发 plan", async () => {
    const { h, id } = await open({
      onPrompt: async (t) => {
        await t.tool({
          id: "t1",
          name: "todo_write",
          result: todoResult([
            { content: "a", status: "in_progress", priority: "high" },
            { content: "b", status: "completed", priority: "low" },
            { content: "c", status: "weird" },
            { status: "pending" },
          ]),
        });
        await t.tool({ id: "t2", name: "todo_write", result: todoResult([]) });
        await t.tool({
          id: "t3",
          name: "todo_write",
          result: todoResult([{ text: "x", done: true }]),
          isError: true,
        });
        await t.tool({ id: "t4", name: "bash", args: { command: "ls" }, gate: {} });
        t.assistantEnd({});
      },
    });
    await h.client.setMode(id, "full-auto");
    await h.client.prompt(id, text("go"));
    expect(h.updatesOf("plan")).toEqual([
      {
        sessionUpdate: "plan",
        entries: [
          { content: "a", priority: "high", status: "in_progress" },
          { content: "b", priority: "low", status: "completed" },
          { content: "c", priority: "medium", status: "pending" },
        ],
      },
      { sessionUpdate: "plan", entries: [] },
    ]);
  });

  it("session/load 的回放末尾补当前计划", async () => {
    h = await bridgeHarness({
      pi: {
        messages: [
          { role: "user", content: "plan" },
          {
            role: "toolResult",
            toolCallId: "t1",
            content: [{ type: "text", text: "ok" }],
            details: { todos: [{ text: "a", done: false }] },
          },
        ],
      },
    });
    await h.client.initialize();
    await h.client.loadSession("44444444-4444-4444-8444-444444444444", CWD);
    expect(
      h.updates.map((n) => n.update.sessionUpdate).filter((k) => k !== "usage_update"),
    ).toEqual(["user_message_chunk", "plan"]);
  });
});

describe("子 Agent", () => {
  it("subagent 工具：kind other，_meta[armadra.subagent] 带 agent 与 task，进度写进 content", async () => {
    const { h, id } = await open({
      onPrompt: async (t) => {
        await t.tool({
          id: "s1",
          name: "subagent",
          args: { agent: "scout", task: "find the entry point" },
          partials: [{ content: [{ type: "text", text: "scout: reading src/" }] }],
          result: { content: [{ type: "text", text: "found" }], details: { mode: "single" } },
          gate: {},
        });
        await t.tool({
          id: "s2",
          name: "subagent",
          args: {
            tasks: [
              { agent: "a", task: "one" },
              { agent: "b", task: "two" },
            ],
          },
          gate: {},
        });
        t.assistantEnd({});
      },
    });
    await h.client.setMode(id, "full-auto");
    await h.client.prompt(id, text("delegate"));
    const calls = h.updatesOf("tool_call");
    expect(calls[0]).toMatchObject({
      toolCallId: "s1",
      kind: "other",
      name: "subagent",
      _meta: { "armadra.subagent": { agent: "scout", task: "find the entry point" } },
    });
    expect(calls[1]).toMatchObject({
      _meta: {
        "armadra.subagent": {
          mode: "parallel",
          tasks: [
            { agent: "a", task: "one" },
            { agent: "b", task: "two" },
          ],
        },
      },
    });
    expect(
      h
        .updatesOf("tool_call_update")
        .some((u) => JSON.stringify(u["content"] ?? "").includes("scout: reading src/")),
    ).toBe(true);
  });
});
