import { describe, expect, it, vi } from "vitest";
import { JsonRpcPeer, RpcError } from "../jsonrpc.js";
import { assertAcpWire } from "../../../test/helpers/acp-schema.js";
import { memoryTransport, type MemoryTransport } from "../test-support.js";
import { AcpClient, isAuthRequiredError } from "./client.js";
import { isTerminalAuthMethod, type AcpAuthMethod } from "./types.js";

const AGENT_METHOD: AcpAuthMethod = {
  id: "oauth",
  name: "Sign in with the agent",
  description: "Opens the browser",
};
const TERMINAL_METHOD: AcpAuthMethod = {
  type: "terminal",
  id: "login",
  name: "Terminal login",
  description: null,
  args: ["--login"],
  env: { NO_BROWSER: "1" },
};

interface Fixture {
  client: AcpClient;
  peer: MemoryTransport;
  init: { clientCapabilities: Record<string, unknown> };
  /** Agent 收到的 authenticate / logout / session/new。 */
  calls: Array<[string, unknown]>;
}

/** 最小的对端 Agent：`handlers` 按方法名答复，其余 method not found。 */
async function connect(
  handlers: Record<string, (params: unknown) => unknown> = {},
  options: { authTerminal?: boolean; capabilities?: Record<string, unknown> } = {},
): Promise<Fixture> {
  const calls: Array<[string, unknown]> = [];
  const fixture = { calls } as Fixture;
  const peer = memoryTransport(async (input, output) => {
    const agent = new JsonRpcPeer({
      input,
      output,
      onRequest: async (method, params) => {
        if (method === "initialize") {
          fixture.init = params as Fixture["init"];
          return {
            protocolVersion: 1,
            agentCapabilities: options.capabilities ?? {},
            authMethods: [AGENT_METHOD, TERMINAL_METHOD],
          };
        }
        calls.push([method, params]);
        const handler = handlers[method];
        if (handler === undefined) throw new RpcError(-32601, `method not found: ${method}`);
        return handler(params);
      },
    });
    await agent.closed;
  });
  const client = new AcpClient({
    input: peer.transport.stdout,
    output: peer.transport.stdin,
    ...(options.authTerminal !== undefined ? { authTerminal: options.authTerminal } : {}),
  });
  await client.initialize();
  fixture.client = client;
  fixture.peer = peer;
  return fixture;
}

describe("AcpClient authMethods", () => {
  it("保留 id / name / description / type / args / env，不只留 id", async () => {
    const { client, peer } = await connect();
    expect(client.authMethods).toEqual([AGENT_METHOD, TERMINAL_METHOD]);
    expect(client.authMethods.map(isTerminalAuthMethod)).toEqual([false, true]);
    await peer.transport.terminate();
  });

  it("authTerminal 缺省不声明 auth.terminal；给了才声明", async () => {
    const plain = await connect();
    expect(plain.init.clientCapabilities).not.toHaveProperty("auth");
    await plain.peer.transport.terminate();
    const withTerminal = await connect({}, { authTerminal: true });
    expect(withTerminal.init.clientCapabilities["auth"]).toEqual({ terminal: true });
    await withTerminal.peer.transport.terminate();
  });
});

describe("AcpClient.authenticate", () => {
  it("发 authenticate { methodId }，答复原样交回，线路过官方 schema", async () => {
    const { client, peer, calls } = await connect({ authenticate: () => ({}) });
    await expect(client.authenticate("oauth")).resolves.toEqual({});
    expect(calls).toEqual([["authenticate", { methodId: "oauth" }]]);
    assertAcpWire(peer.wire);
    await peer.transport.terminate();
  });

  it("terminal 型方法不经 authenticate：本地拒绝 -32602，线路上没有请求", async () => {
    const { client, peer, calls } = await connect({ authenticate: () => ({}) });
    await expect(client.authenticate("login")).rejects.toMatchObject({ code: -32602 });
    expect(calls).toEqual([]);
    await peer.transport.terminate();
  });

  it("未知 id 照样发给 Agent；Agent 的错误码原样抛出（-32000 也是）", async () => {
    const { client, peer, calls } = await connect({
      authenticate: () => {
        throw new RpcError(-32000, "authentication failed");
      },
    });
    const error = await client.authenticate("other").catch((e: unknown) => e);
    expect(isAuthRequiredError(error)).toBe(true);
    expect((error as RpcError).message).toBe("authentication failed");
    expect(calls).toEqual([["authenticate", { methodId: "other" }]]);
    await peer.transport.terminate();
  });

  it("没实现 authenticate 的 Agent：-32601 不是 auth_required", async () => {
    const { client, peer } = await connect();
    const error = await client.authenticate("oauth").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: -32601 });
    expect(isAuthRequiredError(error)).toBe(false);
    await peer.transport.terminate();
  });

  it("signal abort 撤回请求", async () => {
    const { client, peer, calls } = await connect({
      authenticate: () => new Promise(() => undefined),
    });
    const controller = new AbortController();
    const pending = client.authenticate("oauth", controller.signal).catch((e: unknown) => e);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    expect(await pending).toBeDefined();
    await vi.waitFor(() =>
      expect(peer.wire.some((l) => l.msg["method"] === "$/cancel_request")).toBe(true),
    );
    await peer.transport.terminate();
  });
});

describe("AcpClient.logout", () => {
  it("supportsLogout 看 auth.logout 是否存在", async () => {
    const yes = await connect({}, { capabilities: { auth: { logout: {} } } });
    expect(yes.client.supportsLogout()).toBe(true);
    await yes.peer.transport.terminate();
    const no = await connect();
    expect(no.client.supportsLogout()).toBe(false);
    await no.peer.transport.terminate();
  });

  it("发 logout（空参数），线路过官方 schema", async () => {
    const { client, peer, calls } = await connect(
      { logout: () => ({}) },
      { capabilities: { auth: { logout: {} } } },
    );
    await expect(client.logout()).resolves.toEqual({});
    expect(calls).toEqual([["logout", {}]]);
    assertAcpWire(peer.wire);
    await peer.transport.terminate();
  });

  it("Agent 没实现：method not found 原样抛出；-32000 可被识别", async () => {
    const none = await connect();
    await expect(none.client.logout()).rejects.toMatchObject({ code: -32601 });
    await none.peer.transport.terminate();
    const auth = await connect({
      logout: () => {
        throw new RpcError(-32000, "not signed in");
      },
    });
    expect(isAuthRequiredError(await auth.client.logout().catch((e: unknown) => e))).toBe(true);
    await auth.peer.transport.terminate();
  });
});

describe("开会话遇 -32000", () => {
  it("newSession 的错误可用 isAuthRequiredError 判断，authMethods 随时可取", async () => {
    const { client, peer } = await connect({
      "session/new": () => {
        throw new RpcError(-32000, "authentication required");
      },
    });
    const error = await client.newSession("/w").catch((e: unknown) => e);
    expect(isAuthRequiredError(error)).toBe(true);
    expect(client.authMethods.map((m) => m.id)).toEqual(["oauth", "login"]);
    expect(isAuthRequiredError(new RpcError(-32602, "x"))).toBe(false);
    expect(isAuthRequiredError(new Error("x"))).toBe(false);
    await peer.transport.terminate();
  });
});
