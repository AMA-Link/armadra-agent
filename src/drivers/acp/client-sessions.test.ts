import { describe, expect, it, vi } from "vitest";
import { JsonRpcPeer, RpcError } from "../jsonrpc.js";
import { assertAcpWire } from "../../../test/helpers/acp-schema.js";
import { memoryTransport, type MemoryTransport } from "../test-support.js";
import { runFakeAcpAgent } from "./testing/fake-agent.js";
import { AcpClient, isAuthRequiredError, type AcpClientHandlers } from "./client.js";
import type { AcpSessionInfo } from "./types.js";

/** 线路上发给 Agent 的某个方法的 params。 */
function sent(peer: MemoryTransport, method: string): unknown[] {
  return peer.wire
    .filter((line) => line.dir === "in" && line.msg["method"] === method)
    .map((line) => line.msg["params"]);
}

async function connectFake() {
  const peer = memoryTransport((input, output) => runFakeAcpAgent(input, output));
  const client = new AcpClient({ input: peer.transport.stdout, output: peer.transport.stdin });
  await client.initialize();
  return { client, peer };
}

interface Custom {
  client: AcpClient;
  agent: JsonRpcPeer;
  peer: MemoryTransport;
}

/** 对端 Agent：`handlers` 答方法，其余 -32601；声明 list / close 能力。 */
async function connectCustom(
  handlers: Record<string, (params: unknown) => unknown>,
  clientHandlers: Partial<AcpClientHandlers> = {},
): Promise<Custom> {
  const holder = {} as Custom;
  const peer = memoryTransport(async (input, output) => {
    holder.agent = new JsonRpcPeer({
      input,
      output,
      onRequest: async (method, params) => {
        if (method === "initialize")
          return {
            protocolVersion: 1,
            agentCapabilities: { sessionCapabilities: { list: {}, close: {} } },
          };
        const handler = handlers[method];
        if (handler === undefined) throw new RpcError(-32601, `method not found: ${method}`);
        return handler(params);
      },
    });
    await holder.agent.closed;
  });
  holder.peer = peer;
  holder.client = new AcpClient({
    input: peer.transport.stdout,
    output: peer.transport.stdin,
    ...clientHandlers,
  });
  await holder.client.initialize();
  return holder;
}

describe("AcpClient.listSessions", () => {
  it("不带参数发空对象；cwd 与 cursor 只在给了时才发；线路过官方 schema", async () => {
    const { client, peer } = await connectFake();
    const { sessionId } = await client.newSession("/w");
    expect(client.supportsList()).toBe(true);
    await expect(client.listSessions()).resolves.toEqual({
      sessions: [{ sessionId, cwd: "/w" }],
    });
    await client.listSessions("/w");
    await client.listSessions("/w", "c1");
    await client.listSessions(undefined, "c2");
    expect(sent(peer, "session/list")).toEqual([
      {},
      { cwd: "/w" },
      { cwd: "/w", cursor: "c1" },
      { cursor: "c2" },
    ]);
    assertAcpWire(peer.wire);
    await peer.transport.terminate();
  });

  it("答复里的 title / updatedAt / additionalDirectories 原样交回", async () => {
    const info: AcpSessionInfo = {
      sessionId: "s1",
      cwd: "/w",
      additionalDirectories: ["/lib"],
      title: "Fix bug",
      updatedAt: "2026-11-02T10:00:00Z",
    };
    const { client, peer } = await connectCustom({ "session/list": () => ({ sessions: [info] }) });
    await expect(client.listSessions()).resolves.toEqual({ sessions: [info] });
    assertAcpWire(peer.wire);
    await peer.transport.terminate();
  });

  it("listAllSessions 跟 nextCursor 翻页，把游标带进下一次请求", async () => {
    const pages: Record<string, unknown> = {
      "": { sessions: [{ sessionId: "a", cwd: "/w" }], nextCursor: "p2" },
      p2: { sessions: [{ sessionId: "b", cwd: "/w" }], nextCursor: "p3" },
      p3: { sessions: [{ sessionId: "c", cwd: "/w" }], nextCursor: null },
    };
    const { client, peer } = await connectCustom({
      "session/list": (params) => pages[(params as { cursor?: string }).cursor ?? ""],
    });
    const all = await client.listAllSessions("/w");
    expect(all.map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
    expect(sent(peer, "session/list")).toEqual([
      { cwd: "/w" },
      { cwd: "/w", cursor: "p2" },
      { cwd: "/w", cursor: "p3" },
    ]);
    await peer.transport.terminate();
  });

  it("listAllSessions 对端游标不终止时按 maxPages 截止", async () => {
    let calls = 0;
    const { client, peer } = await connectCustom({
      "session/list": () => ({
        sessions: [{ sessionId: `s${++calls}`, cwd: "/w" }],
        nextCursor: "again",
      }),
    });
    expect(await client.listAllSessions(undefined, undefined, 3)).toHaveLength(3);
    expect(calls).toBe(3);
    await peer.transport.terminate();
  });

  it("-32000 与 -32601 原样抛出；没声明 list 能力时 supportsList 为 false", async () => {
    const auth = await connectCustom({
      "session/list": () => {
        throw new RpcError(-32000, "sign in first");
      },
    });
    const error = await auth.client.listSessions().catch((e: unknown) => e);
    expect(isAuthRequiredError(error)).toBe(true);
    await auth.peer.transport.terminate();
    const minimal = memoryTransport((input, output) =>
      runFakeAcpAgent(input, output, { minimal: true }),
    );
    const bare = new AcpClient({
      input: minimal.transport.stdout,
      output: minimal.transport.stdin,
    });
    await bare.initialize();
    expect(bare.supportsList()).toBe(false);
    expect(bare.supportsClose()).toBe(false);
    await minimal.transport.terminate();
    const none = await connectCustom({});
    await expect(none.client.listSessions()).rejects.toMatchObject({ code: -32601 });
    await none.peer.transport.terminate();
  });
});

describe("AcpClient.closeSession", () => {
  it("发 session/close { sessionId }，之后该会话从列表消失；线路过官方 schema", async () => {
    const { client, peer } = await connectFake();
    const a = await client.newSession("/w");
    const b = await client.newSession("/w");
    expect(client.supportsClose()).toBe(true);
    await expect(client.closeSession(a.sessionId)).resolves.toEqual({});
    expect(sent(peer, "session/close")).toEqual([{ sessionId: a.sessionId }]);
    const left = await client.listSessions();
    expect(left.sessions.map((s) => s.sessionId)).toEqual([b.sessionId]);
    assertAcpWire(peer.wire);
    await peer.transport.terminate();
  });

  it("未知会话与未声明能力：Agent 的错误码原样抛出；-32000 可识别", async () => {
    const { client, peer } = await connectFake();
    await expect(client.closeSession("nope")).rejects.toBeInstanceOf(RpcError);
    await peer.transport.terminate();
    const auth = await connectCustom({
      "session/close": () => {
        throw new RpcError(-32000, "sign in first");
      },
    });
    expect(isAuthRequiredError(await auth.client.closeSession("s1").catch((e: unknown) => e))).toBe(
      true,
    );
    await auth.peer.transport.terminate();
    const none = await connectCustom({});
    await expect(none.client.closeSession("s1")).rejects.toMatchObject({ code: -32601 });
    await none.peer.transport.terminate();
  });

  it("等同先取消：该会话挂起的权限请求答 cancelled、elicitation 答 cancel，别的会话不受影响", async () => {
    const closeSeen: unknown[] = [];
    const handled: string[] = [];
    const { client, agent, peer } = await connectCustom(
      { "session/close": (p) => (closeSeen.push(p), {}) },
      {
        onPermission: (params) => {
          handled.push(`permission ${params.sessionId}`);
          return new Promise(() => undefined);
        },
        onElicitation: () => {
          handled.push("elicitation s1");
          return new Promise(() => undefined);
        },
      },
    );
    const option = [{ optionId: "ok", name: "Allow", kind: "allow_once" }];
    const permission = agent.request("session/request_permission", {
      sessionId: "s1",
      toolCall: { toolCallId: "t1" },
      options: option,
    });
    const elicitation = agent.request("elicitation/create", {
      sessionId: "s1",
      mode: "form",
      message: "Pick",
      requestedSchema: { type: "object", properties: {} },
    });
    let otherSettled = false;
    const other = agent
      .request("session/request_permission", {
        sessionId: "s2",
        toolCall: { toolCallId: "t2" },
        options: option,
      })
      .then(
        () => (otherSettled = true),
        () => undefined,
      );
    await vi.waitFor(() => expect(handled).toHaveLength(3));
    await client.closeSession("s1");
    expect(closeSeen).toEqual([{ sessionId: "s1" }]);
    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(elicitation).resolves.toEqual({ action: "cancel" });
    expect(otherSettled).toBe(false);
    await peer.transport.terminate();
    await other;
  });
});
