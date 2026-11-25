import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { JsonRpcPeer, RpcError } from "../jsonrpc.js";
import { assertAcpWire } from "../../../test/helpers/acp-schema.js";
import { memoryTransport, type WireLine } from "../test-support.js";
import { createLineReader } from "../../modes/rpc/jsonl.js";
import { runFakeAcpAgent } from "./testing/fake-agent.js";
import { AcpClient } from "./client.js";
import type { AcpStdioMcpServer } from "./types.js";

const SERVER: AcpStdioMcpServer = {
  name: "canvas",
  command: "/opt/host/bin/canvas-mcp",
  args: ["mcp"],
  env: [{ name: "HOST_NODE_ID", value: "n1" }],
};

/** 起一个假 Agent，返回客户端与线路记录。 */
async function connect() {
  const peer = memoryTransport((input, output) => runFakeAcpAgent(input, output));
  const client = new AcpClient({ input: peer.transport.stdout, output: peer.transport.stdin });
  await client.initialize();
  return { client, peer };
}

/** 线路上发给 Agent 的某个方法的 params。 */
function sent(peer: ReturnType<typeof memoryTransport>, method: string): unknown[] {
  return peer.wire
    .filter((line) => line.dir === "in" && line.msg["method"] === method)
    .map((line) => line.msg["params"]);
}

describe("AcpClient 开会话的 mcpServers", () => {
  it("声明特性，供宿主检测", () => {
    expect(AcpClient.features).toEqual({
      mcpServers: true,
      sessionMeta: true,
      elicitation: true,
      configOptions: true,
      terminal: true,
      auth: true,
      elicitationComplete: true,
      extRequest: true,
    });
  });

  it("缺省发空数组（与旧版逐字节相同）", async () => {
    const { client, peer } = await connect();
    const { sessionId } = await client.newSession("/w");
    await client.resumeSession(sessionId, "/w");
    await client.loadSession(sessionId, "/w");
    expect(sent(peer, "session/new")).toEqual([{ cwd: "/w", mcpServers: [] }]);
    expect(sent(peer, "session/resume")).toEqual([{ sessionId, cwd: "/w", mcpServers: [] }]);
    expect(sent(peer, "session/load")).toEqual([{ sessionId, cwd: "/w", mcpServers: [] }]);
    await peer.transport.terminate();
  });

  it("new / resume / load 原样转发宿主给的服务器", async () => {
    const { client, peer } = await connect();
    const options = { mcpServers: [SERVER] };
    const { sessionId } = await client.newSession("/w", undefined, options);
    await client.resumeSession(sessionId, "/w", undefined, options);
    await client.loadSession(sessionId, "/w", undefined, options);
    for (const method of ["session/new", "session/resume", "session/load"]) {
      expect(sent(peer, method)).toEqual([expect.objectContaining({ mcpServers: [SERVER] })]);
    }
    await peer.transport.terminate();
  });

  it("不改调用方的数组，signal 照常生效", async () => {
    const { client, peer } = await connect();
    const servers = Object.freeze([SERVER]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.newSession("/w", controller.signal, { mcpServers: servers }),
    ).rejects.toThrow();
    expect(servers).toEqual([SERVER]);
    await peer.transport.terminate();
  });
});

describe("AcpClient 开会话的 _meta", () => {
  const META = { antigravity: { systemPrompt: { append: "rules" } }, grok: { yoloMode: true } };

  it("声明 features.sessionMeta", () => {
    expect(AcpClient.features.sessionMeta).toBe(true);
  });

  it("带 meta：new / resume / load 都把它原样放进 _meta", async () => {
    const { client, peer } = await connect();
    const options = { meta: META };
    const { sessionId } = await client.newSession("/w", undefined, options);
    await client.resumeSession(sessionId, "/w", undefined, options);
    await client.loadSession(sessionId, "/w", undefined, options);
    for (const method of ["session/new", "session/resume", "session/load"]) {
      const [params] = sent(peer, method) as Array<Record<string, unknown>>;
      expect(params?.["_meta"]).toEqual(META);
      expect(params?.["mcpServers"]).toEqual([]);
    }
    assertAcpWire(peer.wire);
    await peer.transport.terminate();
  });

  it("与 mcpServers 同时给时两样都发", async () => {
    const { client, peer } = await connect();
    await client.newSession("/w", undefined, { mcpServers: [SERVER], meta: META });
    expect(sent(peer, "session/new")).toEqual([{ cwd: "/w", mcpServers: [SERVER], _meta: META }]);
    assertAcpWire(peer.wire);
    await peer.transport.terminate();
  });

  it.each([
    ["缺席", undefined],
    ["meta 为 undefined", { meta: undefined }],
    ["meta 为空对象", { meta: {} }],
  ])("%s：不发 _meta 键，线路与旧版相同", async (_name, options) => {
    const { client, peer } = await connect();
    const { sessionId } = await client.newSession("/w", undefined, options);
    await client.resumeSession(sessionId, "/w", undefined, options);
    await client.loadSession(sessionId, "/w", undefined, options);
    expect(sent(peer, "session/new")).toEqual([{ cwd: "/w", mcpServers: [] }]);
    expect(sent(peer, "session/resume")).toEqual([{ sessionId, cwd: "/w", mcpServers: [] }]);
    expect(sent(peer, "session/load")).toEqual([{ sessionId, cwd: "/w", mcpServers: [] }]);
    for (const method of ["session/new", "session/resume", "session/load"]) {
      expect(Object.keys(sent(peer, method)[0] as object)).not.toContain("_meta");
    }
    await peer.transport.terminate();
  });

  it("Agent 对带 _meta 的 session/new 回 -32602：RpcError 原样抛出", async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const agent = new JsonRpcPeer({
      input: toAgent,
      output: fromAgent,
      onRequest: async (method) => {
        if (method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
        throw new RpcError(-32602, "bad _meta");
      },
    });
    const client = new AcpClient({ input: fromAgent, output: toAgent });
    await client.initialize();
    const error = await client.newSession("/w", undefined, { meta: META }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: -32602, message: "bad _meta" });
    client.close();
    agent.close();
  });

  it("meta 不进 prompt", async () => {
    const { client, peer } = await connect();
    const { sessionId } = await client.newSession("/w", undefined, { meta: META });
    await client.prompt(sessionId, [{ type: "text", text: "hi" }]);
    expect(JSON.stringify(sent(peer, "session/prompt"))).not.toContain("_meta");
    await peer.transport.terminate();
  });
});

/** 起假 Agent，带上 elicitation 处理器与假 Agent 选项；收集回复文本。 */
async function connectWith(
  options: {
    onElicitation?: ConstructorParameters<typeof AcpClient>[0]["onElicitation"];
    configOptions?: boolean;
  } = {},
) {
  const peer = memoryTransport((input, output) =>
    runFakeAcpAgent(input, output, { configOptions: options.configOptions === true }),
  );
  const replies: string[] = [];
  const client = new AcpClient({
    input: peer.transport.stdout,
    output: peer.transport.stdin,
    onUpdate: (n) => {
      if (n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text")
        replies.push(n.update.content.text);
    },
    ...(options.onElicitation !== undefined ? { onElicitation: options.onElicitation } : {}),
  });
  await client.initialize();
  const { sessionId, configOptions } = await client.newSession("/w");
  return { client, peer, replies, sessionId, configOptions };
}

describe("AcpClient 的 elicitation", () => {
  it("没给处理器：不声明 elicitation，假 Agent 不发", async () => {
    const { client, peer, replies, sessionId } = await connectWith();
    const init = sent(peer, "initialize")[0] as { clientCapabilities: Record<string, unknown> };
    // [ACP-D] 多了 session.configOptions（只认 select）；elicitation 仍不声明
    expect(init.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      session: { configOptions: {} },
    });
    await client.prompt(sessionId, [{ type: "text", text: "[elicit]" }]);
    expect(replies).toEqual(["elicit: unsupported"]);
    await peer.transport.terminate();
  });

  it("给了处理器：声明能力，表单交给它，accept 的内容原样回 Agent", async () => {
    const seen: unknown[] = [];
    const { client, peer, replies, sessionId } = await connectWith({
      onElicitation: async (params) => {
        seen.push(params);
        return { action: "accept", content: { color: "blue", count: 2 } };
      },
    });
    const init = sent(peer, "initialize")[0] as { clientCapabilities: Record<string, unknown> };
    expect(init.clientCapabilities["elicitation"]).toEqual({});
    const result = await client.prompt(sessionId, [{ type: "text", text: "[elicit]" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(seen).toEqual([
      expect.objectContaining({
        sessionId,
        message: "Pick a color",
        requestedSchema: expect.objectContaining({ required: ["color"] }),
      }),
    ]);
    expect(replies).toEqual(['elicit: accept {"color":"blue","count":2}']);
    await peer.transport.terminate();
  });

  it("答复收成规范形状：decline 不带内容，不认识的动作当 cancel", async () => {
    const answers = [
      { action: "decline", content: { color: "red" } },
      { action: "maybe" },
    ] as never[];
    const { client, peer, replies, sessionId } = await connectWith({
      onElicitation: async () => answers.shift()!,
    });
    await client.prompt(sessionId, [{ type: "text", text: "[elicit]" }]);
    const second = await client.prompt(sessionId, [{ type: "text", text: "[elicit]" }]);
    expect(replies).toEqual(["elicit: decline null", "elicit: cancel null"]);
    expect(second.stopReason).toBe("cancelled");
    await peer.transport.terminate();
  });

  it("cancel(sessionId)：挂起的 elicitation 回 cancel，处理器的 signal 被 abort", async () => {
    let aborted: AbortSignal | undefined;
    let asked!: () => void;
    const pending = new Promise<void>((resolve) => (asked = resolve));
    const { client, peer, replies, sessionId } = await connectWith({
      onElicitation: (_params, signal) => {
        aborted = signal;
        asked();
        return new Promise(() => undefined);
      },
    });
    const turn = client.prompt(sessionId, [{ type: "text", text: "[elicit]" }]);
    await pending;
    await client.cancel(sessionId);
    expect((await turn).stopReason).toBe("cancelled");
    expect(aborted?.aborted).toBe(true);
    expect(replies).toEqual(["elicit: cancel null"]);
    await peer.transport.terminate();
  });

  it("连接关闭：处理器的 signal 被 abort", async () => {
    let aborted: AbortSignal | undefined;
    let asked!: () => void;
    const pending = new Promise<void>((resolve) => (asked = resolve));
    const { client, peer, sessionId } = await connectWith({
      onElicitation: (_params, signal) => {
        aborted = signal;
        asked();
        return new Promise(() => undefined);
      },
    });
    void client.prompt(sessionId, [{ type: "text", text: "[elicit]" }]).catch(() => undefined);
    await pending;
    await peer.transport.terminate();
    await client.closed;
    expect(aborted?.aborted).toBe(true);
  });
});

describe("AcpClient 的会话配置项", () => {
  it("假 Agent 缺省不答 configOptions（线路不变）", async () => {
    const { peer, configOptions } = await connectWith();
    expect(configOptions).toBeUndefined();
    await peer.transport.terminate();
  });

  it("开会话交回 configOptions，setConfigOption 改模型、答新状态", async () => {
    const { client, peer, replies, sessionId, configOptions } = await connectWith({
      configOptions: true,
    });
    expect(configOptions).toEqual([
      expect.objectContaining({ id: "model", category: "model", currentValue: "small" }),
    ]);
    const changed = await client.setConfigOption(sessionId, "model", "large");
    expect(changed.configOptions?.[0]?.currentValue).toBe("large");
    expect(sent(peer, "session/set_config_option")).toEqual([
      { sessionId, configId: "model", value: "large" },
    ]);
    await client.prompt(sessionId, [{ type: "text", text: "[model]" }]);
    expect(replies).toEqual(["model large"]);
    const loaded = await client.loadSession(sessionId, "/w");
    expect(loaded.configOptions?.[0]?.currentValue).toBe("large");
    await expect(client.setConfigOption(sessionId, "model", "huge")).rejects.toThrow(
      /unknown model/,
    );
    await peer.transport.terminate();
  });

  it("假 Agent 的 [env NAME] 只回值的摘要", async () => {
    const { client, peer, replies, sessionId } = await connectWith();
    process.env["AMA_FAKE_ENV_PROBE"] = "secret";
    try {
      await client.prompt(sessionId, [{ type: "text", text: "[env AMA_FAKE_ENV_PROBE]" }]);
      await client.prompt(sessionId, [{ type: "text", text: "[env AMA_FAKE_ENV_MISSING]" }]);
    } finally {
      delete process.env["AMA_FAKE_ENV_PROBE"];
    }
    expect(replies[0]).toMatch(/^env AMA_FAKE_ENV_PROBE [0-9a-f]{64}$/);
    expect(replies[0]).not.toContain("secret");
    expect(replies[1]).toBe("env AMA_FAKE_ENV_MISSING absent");
    await peer.transport.terminate();
  });
});

describe("[ACP-D] AcpClient 的 $/cancel_request", () => {
  it("本端请求的 signal 在发出后 abort → 通知 Agent 撤回；线路过 schema", async () => {
    const { client, peer, sessionId } = await connectWith();
    const controller = new AbortController();
    const pending = client.prompt(sessionId, [{ type: "text", text: "[slow]" }], controller.signal);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    await client.cancel(sessionId);
    await new Promise((r) => setTimeout(r, 10));
    const prompt = peer.wire.find((w) => w.msg["method"] === "session/prompt")!;
    expect(sent(peer, "$/cancel_request")).toEqual([{ requestId: prompt.msg["id"] }]);
    assertAcpWire(peer.wire);
    await peer.transport.terminate();
  });

  it("Agent 撤回挂起的权限请求 → 处理器的 signal abort，回 cancelled", async () => {
    const peer = memoryTransport((input, output) =>
      runFakeAcpAgent(input, output, { cancelRequestMs: 20 }),
    );
    let seen: AbortSignal | undefined;
    const client = new AcpClient({
      input: peer.transport.stdout,
      output: peer.transport.stdin,
      onPermission: (_params, signal) =>
        new Promise((resolve) => {
          seen = signal;
          signal.addEventListener("abort", () =>
            resolve({ outcome: { outcome: "selected", optionId: "allow" } }),
          );
        }),
    });
    await client.initialize();
    const { sessionId } = await client.newSession("/w");
    const result = await client.prompt(sessionId, [{ type: "text", text: "[cancel-request]" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(seen?.aborted).toBe(true);
    const ask = peer.wire.find((w) => w.msg["method"] === "session/request_permission")!;
    const answer = peer.wire.find(
      (w) => w.dir === "in" && w.msg["id"] === ask.msg["id"] && "result" in w.msg,
    );
    // 撤回后处理器给的选择不作数
    expect(answer?.msg["result"]).toEqual({ outcome: { outcome: "cancelled" } });
    assertAcpWire(peer.wire);
    await peer.transport.terminate();
  });
});

describe("AcpClient 的 terminal/*", () => {
  type OnTerminal = NonNullable<ConstructorParameters<typeof AcpClient>[0]["onTerminal"]>;

  /** 客户端与一个最小的对端 Agent（只答 initialize），返回 initialize 收到的参数。 */
  async function connectTerminal(onTerminal?: OnTerminal) {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    let initParams: { clientCapabilities: Record<string, unknown> } | undefined;
    const agent = new JsonRpcPeer({
      input: toAgent,
      output: fromAgent,
      onRequest: async (method, params) => {
        if (method !== "initialize") throw new RpcError(-32601, method);
        initParams = params as typeof initParams;
        return { protocolVersion: 1, agentCapabilities: {} };
      },
    });
    const client = new AcpClient({
      input: fromAgent,
      output: toAgent,
      ...(onTerminal !== undefined ? { onTerminal } : {}),
    });
    await client.initialize();
    return {
      agent,
      client,
      capabilities: initParams!.clientCapabilities,
      close: () => {
        client.close();
        agent.close();
      },
    };
  }

  it("没给处理器：不声明 terminal，terminal/* 回 method not found", async () => {
    const { agent, capabilities, close } = await connectTerminal();
    expect(capabilities["terminal"]).toBe(false);
    await expect(
      agent.request("terminal/create", { sessionId: "s", command: "ls" }),
    ).rejects.toMatchObject({
      code: -32601,
    });
    close();
  });

  it("给了处理器：声明 terminal: true，五个方法与参数原样交给它，返回值即答复", async () => {
    const seen: Array<[string, unknown]> = [];
    const { agent, capabilities, close } = await connectTerminal(async (method, params) => {
      seen.push([method, params]);
      return { method };
    });
    expect(capabilities["terminal"]).toBe(true);
    for (const method of [
      "terminal/create",
      "terminal/output",
      "terminal/wait_for_exit",
      "terminal/kill",
      "terminal/release",
    ]) {
      await expect(agent.request(method, { terminalId: "t1" })).resolves.toEqual({ method });
    }
    expect(seen).toHaveLength(5);
    expect(seen[0]).toEqual(["terminal/create", { terminalId: "t1" }]);
    close();
  });

  it("session/cancel 让该会话挂起的 terminal 回调 abort，回调不理会 signal 也答 -32800", async () => {
    let signal: AbortSignal | undefined;
    const { agent, client, close } = await connectTerminal((_m, _p, s) => {
      signal = s;
      return new Promise(() => undefined);
    });
    const pending = agent.request("terminal/create", { sessionId: "s1", command: "ls" });
    const settled = expect(pending).rejects.toMatchObject({ code: -32800 });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await client.cancel("s1");
    expect(signal?.aborted).toBe(true);
    await settled;
    close();
  });

  it("处理器抛 RpcError 即回对应错误；非 terminal/ 方法仍 method not found", async () => {
    const { agent, close } = await connectTerminal(async () => {
      throw new RpcError(-32602, "bad cwd");
    });
    await expect(agent.request("terminal/create", {})).rejects.toMatchObject({ code: -32602 });
    await expect(agent.request("fs/read_text_file", {})).rejects.toMatchObject({ code: -32601 });
    close();
  });
});

describe("AcpClient 的扩展请求 _*", () => {
  type OnExt = NonNullable<ConstructorParameters<typeof AcpClient>[0]["onExtRequest"]>;
  const PARAMS = { sessionId: "s1", toolCallId: "call-1", planContent: "# 计划" };

  /** 客户端与一个最小的对端 Agent（只答 initialize）；对端也开 `$/cancel_request`，并录线。 */
  async function connectExt(onExtRequest?: OnExt) {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();
    const wire: WireLine[] = [];
    const tap = (stream: PassThrough, dir: "in" | "out"): void => {
      createLineReader(stream, (line) => {
        wire.push({ dir, msg: JSON.parse(line) as Record<string, unknown> });
      });
    };
    tap(toAgent, "in");
    tap(fromAgent, "out");
    const agent = new JsonRpcPeer({
      input: toAgent,
      output: fromAgent,
      cancelRequests: true,
      onRequest: async (method) => {
        if (method !== "initialize") throw new RpcError(-32601, method);
        return { protocolVersion: 1, agentCapabilities: {} };
      },
    });
    const protocolErrors: string[] = [];
    const client = new AcpClient({
      input: fromAgent,
      output: toAgent,
      onProtocolError: (_line, reason) => protocolErrors.push(reason),
      ...(onExtRequest !== undefined ? { onExtRequest } : {}),
    });
    await client.initialize();
    return {
      agent,
      client,
      wire,
      protocolErrors,
      close: () => {
        client.close();
        agent.close();
      },
    };
  }

  it("features.extRequest 为 true", () => {
    expect(AcpClient.features.extRequest).toBe(true);
  });

  it("方法名与参数原样交给回调，返回值原样作为 result", async () => {
    const seen: Array<[string, unknown]> = [];
    const { agent, wire, close } = await connectExt(async (method, params) => {
      seen.push([method, params]);
      return { outcome: "approved", extra: [1, 2] };
    });
    await expect(agent.request("_x.ai/exit_plan_mode", PARAMS)).resolves.toEqual({
      outcome: "approved",
      extra: [1, 2],
    });
    expect(seen).toEqual([["_x.ai/exit_plan_mode", PARAMS]]);
    assertAcpWire(wire);
    close();
  });

  it("回调抛 RpcError 回对应错误；抛其他异常对端只看到 internal error，原文交给 onProtocolError", async () => {
    let n = 0;
    const { agent, wire, protocolErrors, close } = await connectExt(async () => {
      if (n++ === 0) throw new RpcError(-32602, "bad plan");
      throw new Error("secret detail");
    });
    await expect(agent.request("_x.ai/exit_plan_mode", PARAMS)).rejects.toMatchObject({
      code: -32602,
      message: "bad plan",
    });
    await expect(agent.request("_x.ai/ask_user_question", PARAMS)).rejects.toMatchObject({
      code: -32603,
      message: "internal error",
    });
    expect(protocolErrors).toEqual(["_x.ai/ask_user_question: secret detail"]);
    expect(JSON.stringify(wire)).not.toContain("secret detail");
    assertAcpWire(wire);
    close();
  });

  it("没给回调：扩展请求回 -32601", async () => {
    const { agent, close } = await connectExt();
    await expect(agent.request("_x.ai/exit_plan_mode", PARAMS)).rejects.toMatchObject({
      code: -32601,
    });
    close();
  });

  it("给了回调：非 _ 前缀的未知方法仍回 -32601，且不进回调", async () => {
    const seen: string[] = [];
    const { agent, close } = await connectExt(async (method) => {
      seen.push(method);
      return {};
    });
    await expect(agent.request("fs/read_text_file", {})).rejects.toMatchObject({ code: -32601 });
    await expect(agent.request("x.ai/exit_plan_mode", {})).rejects.toMatchObject({ code: -32601 });
    expect(seen).toEqual([]);
    close();
  });

  /** 挂起的回调：记下 signal，且不理会它。 */
  function hanging() {
    const state: { signal?: AbortSignal } = {};
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const handler: OnExt = (_m, _p, s) => {
      state.signal = s;
      started();
      return new Promise(() => undefined);
    };
    return { state, running, handler };
  }

  it("对端撤回请求时 signal 触发，错误响应 -32800", async () => {
    const h = hanging();
    const { agent, wire, close } = await connectExt(h.handler);
    const controller = new AbortController();
    const pending = agent.request("_x.ai/exit_plan_mode", PARAMS, controller.signal);
    pending.catch(() => undefined);
    await h.running;
    expect(h.state.signal?.aborted).toBe(false);
    controller.abort();
    await vi.waitFor(() => expect(h.state.signal?.aborted).toBe(true));
    const id = wire.find((l) => l.dir === "out" && l.msg["method"] === "_x.ai/exit_plan_mode")?.msg[
      "id"
    ];
    await vi.waitFor(() =>
      expect(
        wire.find((l) => l.dir === "in" && l.msg["id"] === id && l.msg["error"] !== undefined)?.msg[
          "error"
        ],
      ).toMatchObject({ code: -32800 }),
    );
    close();
  });

  it("连接关闭时 signal 触发", async () => {
    const h = hanging();
    const { agent, close } = await connectExt(h.handler);
    agent.request("_x.ai/exit_plan_mode", PARAMS).catch(() => undefined);
    await h.running;
    close();
    await vi.waitFor(() => expect(h.state.signal?.aborted).toBe(true));
  });

  it("session/cancel 与 closeSession 让该会话挂起的扩展回调 abort，回调不理会 signal 也答 -32800", async () => {
    for (const end of ["cancel", "close"] as const) {
      const h = hanging();
      const { agent, client, close } = await connectExt(h.handler);
      const pending = agent.request("_x.ai/exit_plan_mode", PARAMS);
      const settled = expect(pending).rejects.toMatchObject({ code: -32800 });
      await h.running;
      // 别的会话不受影响
      if (end === "cancel") await client.cancel("other");
      expect(h.state.signal?.aborted).toBe(false);
      if (end === "cancel") await client.cancel("s1");
      else void client.closeSession("s1").catch(() => undefined);
      expect(h.state.signal?.aborted).toBe(true);
      await settled;
      close();
    }
  });
});
