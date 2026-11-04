import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeHarness, tick, type BridgeHarness } from "../../../test/helpers/bridge-harness.js";
import type { FakePiConfig, FakePiTurn } from "../../../test/helpers/fake-pi.js";
import type { AcpElicitationParams, AcpElicitationResult } from "../../drivers/acp/types.js";
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

type Ask = (params: AcpElicitationParams, signal: AbortSignal) => Promise<AcpElicitationResult>;

async function open(pi: FakePiConfig, onElicitation?: Ask) {
  const asked: AcpElicitationParams[] = [];
  h = await bridgeHarness({
    pi,
    handlers: {
      ...(onElicitation !== undefined
        ? {
            onElicitation: async (params, signal) => {
              asked.push(params);
              return onElicitation(params, signal);
            },
          }
        : {}),
    },
  });
  await h.client.initialize();
  const created = await h.client.newSession(CWD);
  return { h, asked, id: created.sessionId };
}

describe("对话框 → elicitation/create", () => {
  const dialogs = (...requests: Record<string, unknown>[]) => {
    const replies: Record<string, unknown>[] = [];
    return {
      replies,
      onPrompt: async (t: FakePiTurn) => {
        for (const request of requests) replies.push(await t.ui(request));
        t.assistantEnd({});
      },
    };
  };

  it("select：带标题的枚举，accept 的值回给 pi", async () => {
    const d = dialogs({ method: "select", title: "Pick one", options: ["Alpha", "Beta"] });
    const { h, asked, id } = await open({ onPrompt: d.onPrompt }, async () => ({
      action: "accept",
      content: { value: "Beta" },
    }));
    await h.client.prompt(id, text("go"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      sessionId: id,
      mode: "form",
      message: "Pick one",
      requestedSchema: {
        type: "object",
        properties: {
          value: {
            type: "string",
            title: "Pick one",
            oneOf: [
              { const: "Alpha", title: "Alpha" },
              { const: "Beta", title: "Beta" },
            ],
          },
        },
        required: ["value"],
      },
    });
    expect(d.replies[0]).toMatchObject({ value: "Beta" });
  });

  it("confirm → boolean；input / editor → string（editor 的预填作默认值）", async () => {
    const d = dialogs(
      { method: "confirm", title: "Clear?", message: "All gone." },
      { method: "input", title: "Name", placeholder: "type it" },
      { method: "editor", title: "Edit", prefill: "line 1" },
    );
    const answers: AcpElicitationResult[] = [
      { action: "accept", content: { confirmed: true } },
      { action: "accept", content: { value: "ama" } },
      { action: "accept", content: { value: "line 1\nline 2" } },
    ];
    const { h, asked, id } = await open({ onPrompt: d.onPrompt }, async () => answers.shift()!);
    await h.client.prompt(id, text("go"));
    expect(asked.map((a) => a.message)).toEqual(["Clear?\nAll gone.", "Name", "Edit"]);
    expect(asked[0]?.requestedSchema?.properties).toEqual({
      confirmed: { type: "boolean", title: "Clear?", default: false },
    });
    expect(asked[1]?.requestedSchema?.properties["value"]).toMatchObject({
      type: "string",
      description: "type it",
    });
    expect(asked[2]?.requestedSchema?.properties["value"]).toMatchObject({ default: "line 1" });
    expect(d.replies).toEqual([
      expect.objectContaining({ confirmed: true }),
      expect.objectContaining({ value: "ama" }),
      expect.objectContaining({ value: "line 1\nline 2" }),
    ]);
  });

  it("decline、cancel、选项之外的值：pi 一侧都是 cancelled，桥不替人选", async () => {
    const d = dialogs(
      { method: "select", title: "A", options: ["x"] },
      { method: "confirm", title: "B" },
      { method: "select", title: "C", options: ["x", "y"] },
      { method: "input", title: "D" },
    );
    const answers: AcpElicitationResult[] = [
      { action: "decline" },
      { action: "cancel" },
      { action: "accept", content: { value: "z" } },
      { action: "accept", content: {} },
    ];
    const { h, id } = await open({ onPrompt: d.onPrompt }, async () => answers.shift()!);
    await h.client.prompt(id, text("go"));
    expect(d.replies.map((r) => r["cancelled"])).toEqual([true, true, true, true]);
    expect(d.replies.every((r) => !("value" in r) && !("confirmed" in r))).toBe(true);
  });

  it("客户端没声明 elicitation：取消并在 stderr 说一行，不发请求；没有可选项的 select 同样取消", async () => {
    const d = dialogs({ method: "select", title: "Pick", options: ["a"] });
    const { h, id } = await open({ onPrompt: d.onPrompt });
    await h.client.prompt(id, text("go"));
    expect(d.replies[0]).toMatchObject({ cancelled: true });
    expect(h.stderr.join("")).toMatch(/does not support elicitation/);
    expect(h.wire.some((w) => w.msg["method"] === "elicitation/create")).toBe(false);
    const empty = dialogs({ method: "select", title: "Nothing", options: [] });
    await h.finish();
    const second = await open({ onPrompt: empty.onPrompt }, async () => ({ action: "cancel" }));
    await second.h.client.prompt(second.id, text("go"));
    expect(empty.replies[0]).toMatchObject({ cancelled: true });
    expect(second.asked).toEqual([]);
  });

  it("pi 的 timeout 到点：撤回给客户端的请求（signal abort），pi 一侧取消", async () => {
    const d = dialogs({ method: "confirm", title: "Quick", timeout: 40 });
    let seen: AbortSignal | undefined;
    const { h, id } = await open({ onPrompt: d.onPrompt }, (_p, signal) => {
      seen = signal;
      return new Promise(() => undefined);
    });
    await h.client.prompt(id, text("go"));
    expect(seen?.aborted).toBe(true);
    expect(d.replies[0]).toMatchObject({ cancelled: true });
    await tick(10);
    expect(h.wire.some((w) => w.msg["method"] === "$/cancel_request" && w.dir === "out")).toBe(
      true,
    );
  });

  it("session/cancel 撤回挂起的征询", async () => {
    const d = dialogs({ method: "input", title: "Waiting" });
    let seen: AbortSignal | undefined;
    const { h, id } = await open(
      {
        onPrompt: async (t) => {
          await d.onPrompt(t);
          await t.aborted;
        },
      },
      (_p, signal) => {
        seen = signal;
        return new Promise(() => undefined);
      },
    );
    const running = h.client.prompt(id, text("go"));
    await tick(50);
    await h.client.cancel(id);
    expect((await running).stopReason).toBe("cancelled");
    expect(seen?.aborted).toBe(true);
    expect(d.replies[0]).toMatchObject({ cancelled: true });
  });

  it("ama 自己的对话框（审批闸、拒绝理由、能力报告）不转成征询", async () => {
    const { h, asked, id } = await open(
      {
        onPrompt: async (t) => {
          await t.tool({ id: "w1", name: "write", args: { path: "a" }, gate: {} });
          t.assistantEnd({});
        },
      },
      async () => ({ action: "cancel" }),
    );
    await h.client.prompt(id, text("go"));
    expect(asked).toEqual([]);
  });
});
