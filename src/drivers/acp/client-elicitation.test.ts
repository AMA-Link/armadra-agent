import { describe, expect, it, vi } from "vitest";
import { JsonRpcPeer } from "../jsonrpc.js";
import { assertAcpWire } from "../../../test/helpers/acp-schema.js";
import { memoryTransport, type MemoryTransport } from "../test-support.js";
import { AcpClient, type AcpClientHandlers } from "./client.js";
import {
  multiSelectOptions,
  singleSelectOptions,
  type AcpElicitationField,
  type AcpElicitationParams,
  type AcpElicitationResult,
} from "./types.js";

interface Fixture {
  client: AcpClient;
  agent: JsonRpcPeer;
  peer: MemoryTransport;
  capabilities: Record<string, unknown>;
}

/** 客户端与一个只答 initialize 的对端 Agent；`agent` 用来主动发 elicitation 请求与通知。 */
async function connect(handlers: Partial<AcpClientHandlers> = {}): Promise<Fixture> {
  const holder = {} as Fixture;
  const peer = memoryTransport(async (input, output) => {
    holder.agent = new JsonRpcPeer({
      input,
      output,
      onRequest: async (method, params) => {
        if (method !== "initialize") throw new Error(`unexpected ${method}`);
        holder.capabilities = (
          params as { clientCapabilities: Record<string, unknown> }
        ).clientCapabilities;
        return { protocolVersion: 1, agentCapabilities: {} };
      },
    });
    await holder.agent.closed;
  });
  holder.peer = peer;
  holder.client = new AcpClient({
    input: peer.transport.stdout,
    output: peer.transport.stdin,
    ...handlers,
  });
  await holder.client.initialize();
  return holder;
}

const TAGS: AcpElicitationField = {
  type: "array",
  title: "Tags",
  minItems: 1,
  maxItems: 2,
  items: { type: "string", enum: ["bug", "ui", "docs"] },
  default: ["ui"],
};
const TITLED: AcpElicitationField = {
  type: "array",
  items: {
    anyOf: [
      { const: "a", title: "Alpha" },
      { const: "b", title: "Beta" },
    ],
  },
};
const ONE_OF: AcpElicitationField = {
  type: "string",
  oneOf: [
    { const: "red", title: "Red" },
    { const: "blue", title: "Blue" },
  ],
};

const FORM: AcpElicitationParams = {
  sessionId: "s1",
  mode: "form",
  message: "Pick",
  requestedSchema: {
    type: "object",
    properties: { tags: TAGS, titled: TITLED, color: ONE_OF },
    required: ["tags"],
  },
};

describe("AcpClient 表单字段：array 多选与 oneOf", () => {
  it("字段原样交给 onElicitation，多选答复是字符串数组，线路过官方 schema", async () => {
    const seen: AcpElicitationParams[] = [];
    const { agent, peer } = await connect({
      onElicitation: async (params): Promise<AcpElicitationResult> => {
        seen.push(params);
        return { action: "accept", content: { tags: ["bug", "ui"], titled: ["b"], color: "blue" } };
      },
    });
    const answer = await agent.request("elicitation/create", FORM);
    expect(seen).toEqual([FORM]);
    expect(answer).toEqual({
      action: "accept",
      content: { tags: ["bug", "ui"], titled: ["b"], color: "blue" },
    });
    assertAcpWire(peer.wire);
    await peer.transport.terminate();
  });

  it("multiSelectOptions / singleSelectOptions 收成统一的 { const, title } 列表", () => {
    expect(multiSelectOptions(TAGS)).toEqual([
      { const: "bug", title: "bug" },
      { const: "ui", title: "ui" },
      { const: "docs", title: "docs" },
    ]);
    expect(multiSelectOptions(TITLED)).toEqual([
      { const: "a", title: "Alpha" },
      { const: "b", title: "Beta" },
    ]);
    expect(singleSelectOptions(ONE_OF)).toEqual([
      { const: "red", title: "Red" },
      { const: "blue", title: "Blue" },
    ]);
    expect(singleSelectOptions({ type: "string", enum: ["x", "y"], enumNames: ["X"] })).toEqual([
      { const: "x", title: "X" },
      { const: "y", title: "y" },
    ]);
    // 不是对应控件、或没有枚举：undefined，宿主据此降级成输入框
    expect(multiSelectOptions({ type: "string" })).toBeUndefined();
    expect(multiSelectOptions({ type: "array", items: {} })).toBeUndefined();
    expect(singleSelectOptions({ type: "string" })).toBeUndefined();
    expect(singleSelectOptions(TAGS)).toBeUndefined();
  });
});

describe("AcpClient elicitation/complete", () => {
  it("elicitation 能力：没处理器不声明；只给 onElicitation 是 {}（旧线路）；再给 complete 声明 form 与 url", async () => {
    const none = await connect();
    expect(none.capabilities).not.toHaveProperty("elicitation");
    await none.peer.transport.terminate();
    const legacy = await connect({ onElicitation: async () => ({ action: "cancel" }) });
    expect(legacy.capabilities["elicitation"]).toEqual({});
    await legacy.peer.transport.terminate();
    const both = await connect({
      onElicitation: async () => ({ action: "cancel" }),
      onElicitationComplete: () => undefined,
    });
    expect(both.capabilities["elicitation"]).toEqual({ form: {}, url: {} });
    await both.peer.transport.terminate();
  });

  it("通知交给 onElicitationComplete，参数原样；线路过官方 schema", async () => {
    const seen: unknown[] = [];
    const { agent, peer } = await connect({ onElicitationComplete: (p) => seen.push(p) });
    await agent.notify("elicitation/complete", { elicitationId: "e1" });
    await vi.waitFor(() => expect(seen).toEqual([{ elicitationId: "e1" }]));
    assertAcpWire(peer.wire);
    await peer.transport.terminate();
  });

  it("参数缺 elicitationId 的通知被忽略；没给处理器也不出错", async () => {
    const seen: unknown[] = [];
    const withHandler = await connect({ onElicitationComplete: (p) => seen.push(p) });
    await withHandler.agent.notify("elicitation/complete", { elicitationId: 7 });
    await withHandler.agent.notify("elicitation/complete", null);
    await withHandler.agent.notify("elicitation/complete", { elicitationId: "ok" });
    await vi.waitFor(() => expect(seen).toEqual([{ elicitationId: "ok" }]));
    await withHandler.peer.transport.terminate();
    const without = await connect();
    await without.agent.notify("elicitation/complete", { elicitationId: "e1" });
    expect(without.client.isOpen).toBe(true);
    await without.peer.transport.terminate();
  });

  it("URL 型：mode / url / elicitationId 交给处理器；同 id 还挂着时 complete 让它的 signal abort、答 cancel", async () => {
    let handlerSignal: AbortSignal | undefined;
    const seen: AcpElicitationParams[] = [];
    const completed: unknown[] = [];
    const { agent, peer } = await connect({
      onElicitation: (params, signal) => {
        seen.push(params);
        handlerSignal = signal;
        return new Promise(() => undefined); // 用户还没点
      },
      onElicitationComplete: (p) => completed.push(p),
    });
    const pending = agent.request("elicitation/create", {
      sessionId: "s1",
      mode: "url",
      message: "Sign in",
      elicitationId: "e9",
      url: "https://example.com/auth",
    });
    await vi.waitFor(() => expect(handlerSignal).toBeDefined());
    expect(seen[0]).toMatchObject({
      mode: "url",
      elicitationId: "e9",
      url: "https://example.com/auth",
    });
    expect(handlerSignal?.aborted).toBe(false);
    await agent.notify("elicitation/complete", { elicitationId: "other" });
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(handlerSignal?.aborted).toBe(false);
    await agent.notify("elicitation/complete", { elicitationId: "e9" });
    await expect(pending).resolves.toEqual({ action: "cancel" });
    expect(handlerSignal?.aborted).toBe(true);
    expect(completed).toEqual([{ elicitationId: "other" }, { elicitationId: "e9" }]);
    assertAcpWire(peer.wire);
    await peer.transport.terminate();
  });

  it("已经答复过的 elicitation：complete 只通知宿主，不再 abort 任何东西", async () => {
    const signals: AbortSignal[] = [];
    const completed: unknown[] = [];
    const { agent, peer } = await connect({
      onElicitation: async (_params, signal) => {
        signals.push(signal);
        return { action: "accept" };
      },
      onElicitationComplete: (p) => completed.push(p),
    });
    await expect(
      agent.request("elicitation/create", {
        sessionId: "s1",
        mode: "url",
        message: "Sign in",
        elicitationId: "e1",
        url: "https://example.com/auth",
      }),
    ).resolves.toEqual({ action: "accept" });
    await agent.notify("elicitation/complete", { elicitationId: "e1" });
    await vi.waitFor(() => expect(completed).toEqual([{ elicitationId: "e1" }]));
    expect(signals.map((s) => s.aborted)).toEqual([false]);
    await peer.transport.terminate();
  });
});
