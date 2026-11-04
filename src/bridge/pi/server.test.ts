import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeHarness, tick, type BridgeHarness } from "../../../test/helpers/bridge-harness.js";
import { FAKE_MODELS, type FakePiConfig } from "../../../test/helpers/fake-pi.js";
import { RpcError } from "../../drivers/jsonrpc.js";
import { setLocale } from "../../i18n/index.js";

let h: BridgeHarness | undefined;
// 测试默认钉在 zh；桥的断言按英文文案写
beforeEach(() => setLocale("en"));
afterEach(async () => {
  setLocale("zh");
  // 每条线上消息都要过官方 schema：校验失败在这里抛出
  await h?.finish();
  h = undefined;
});

const CWD = process.platform === "win32" ? "C:\\work" : "/work";
const NO_EXTRAS = { todo: false, subagent: false, questionnaire: false };
const text = (t: string) => [{ type: "text" as const, text: t }];

async function open(config: FakePiConfig = {}, options: Parameters<typeof bridgeHarness>[0] = {}) {
  h = await bridgeHarness({ pi: config, ...options });
  await h.client.initialize();
  const created = await h.client.newSession(CWD);
  return { h, created, id: created.sessionId };
}

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    return error as RpcError;
  }
  throw new Error("expected a rejection");
}

describe("initialize 与会话生命周期", () => {
  it("能力：loadSession、resume / close、http MCP；不报 list，没有认证方法", async () => {
    h = await bridgeHarness();
    const init = await h.client.initialize();
    expect(init).toMatchObject({
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
        sessionCapabilities: { resume: {}, close: {} },
      },
    });
    expect(init.agentCapabilities?.sessionCapabilities).not.toHaveProperty("list");
  });

  it("session/new：--session-id 就是 ACP sessionId；cwd 给 pi；配置项与 _meta", async () => {
    const { h, created, id } = await open();
    const spec = h.pi.last().spec;
    expect(spec.args.slice(0, 4)).toEqual(["--mode", "rpc", "--session-id", id]);
    expect(spec.args).toContain("-e");
    expect(spec.cwd).toBe(CWD);
    expect(spec.env["AMA"]).toBeUndefined();
    expect(created.configOptions?.map((o) => o.id)).toEqual(["model", "thought_level"]);
    const [model, level] = created.configOptions!;
    expect(model).toMatchObject({
      category: "model",
      currentValue: "fakeco/alpha",
      options: [
        { group: "fakeco", options: [{ value: "fakeco/alpha" }, { value: "fakeco/beta" }] },
        { group: "other", options: [{ value: "other/gamma/1" }] },
      ],
    });
    expect(level).toMatchObject({
      category: "thought_level",
      currentValue: "medium",
      options: [{ value: "off" }, { value: "low" }, { value: "medium" }, { value: "high" }],
    });
    expect((created as unknown as { _meta: unknown })._meta).toEqual({
      "armadra.pi": { version: "1.5.0", verified: true, capabilities: NO_EXTRAS },
    });
    expect(h.pi.last().unknown).toEqual([]);
  });

  it("开会话之后发 usage_update：上下文占用、窗口与费用", async () => {
    const { h } = await open();
    await tick(30);
    expect(h.updatesOf("usage_update")).toEqual([
      {
        sessionUpdate: "usage_update",
        used: 1234,
        size: 200000,
        cost: { amount: 0.42, currency: "USD" },
      },
    ]);
  });

  it("session/close：结束进程、清理扩展目录；之后再发 prompt 答 -32002", async () => {
    const { h, id } = await open();
    const path = h.pi.last().extensionPath!;
    expect(existsSync(path)).toBe(true);
    await h.client.closeSession(id);
    await h.pi.last().mem.done;
    expect(existsSync(path)).toBe(false);
    const error = await rejection(h.client.prompt(id, text("hi")));
    expect(error.code).toBe(-32002);
  });

  it("stdin 关闭：收掉全部 pi 子进程，退出 0", async () => {
    const opened = await open();
    await opened.h.client.newSession(CWD);
    expect(opened.h.pi.instances).toHaveLength(2);
    expect(await opened.h.finish()).toBe(0);
    for (const instance of opened.h.pi.instances) await instance.mem.done;
  });

  it("没有可用模型：pi_no_model，进程收掉", async () => {
    h = await bridgeHarness({ pi: { models: [], model: null } });
    await h.client.initialize();
    const error = await rejection(h.client.newSession(CWD));
    expect(error.data).toMatchObject({ code: "pi_no_model" });
    expect(error.message).toContain("/login");
    await h.pi.last().mem.done;
  });

  it("cwd 必须是绝对路径", async () => {
    h = await bridgeHarness();
    await h.client.initialize();
    expect((await rejection(h.client.newSession("relative/dir"))).code).toBe(-32602);
    expect(h.pi.instances).toHaveLength(0);
  });

  it("pi 启动后卡死：get_state 10 秒截止由核心兜底（这里直接让进程退出）", async () => {
    h = await bridgeHarness({ pi: { hangOn: "get_state" } });
    await h.client.initialize();
    const opening = h.client.newSession(CWD);
    await tick(20);
    await h.pi.last().mem.transport.terminate();
    const error = await rejection(opening);
    expect(error.message).toMatch(/pi exited/);
  });
});

describe("版本适配", () => {
  it("1.0.4：pi_outdated，带已装版本、最低版本与包名；不起进程", async () => {
    h = await bridgeHarness({ pi: { version: "1.0.4" } });
    await h.client.initialize();
    const error = await rejection(h.client.newSession(CWD));
    expect(error.data).toEqual({
      code: "pi_outdated",
      installed: "1.0.4",
      minimum: "1.1.0",
      package: "@earendil-works/pi-coding-agent",
    });
    expect(h.pi.instances).toHaveLength(0);
  });

  it("找不到 pi：pi_missing", async () => {
    h = await bridgeHarness({ pi: { missing: true } });
    await h.client.initialize();
    const error = await rejection(h.client.newSession(CWD));
    expect(error.data).toMatchObject({
      code: "pi_missing",
      package: "@earendil-works/pi-coding-agent",
    });
  });

  it.each(["1.1.0", "1.4.0", "1.5.0"])("%s：已验证区间，没有提示", async (version) => {
    const { h, created } = await open({ version });
    expect((created as unknown as { _meta: Record<string, unknown> })._meta).toEqual({
      "armadra.pi": { version, verified: true, capabilities: NO_EXTRAS },
    });
    expect(h.stderr).toEqual([]);
    expect(h.pi.last().unknown).toEqual([]);
  });

  it("2.0.0 与读不出版本：照跑，stderr 一行，_meta.verified 为 false", async () => {
    const newer = await open({ version: "2.0.0" });
    expect((newer.created as unknown as { _meta: unknown })._meta).toEqual({
      "armadra.pi": { version: "2.0.0", verified: false, capabilities: NO_EXTRAS },
    });
    expect(newer.h.stderr.join("")).toMatch(/pi 2\.0\.0 is outside the verified range/);
    await newer.h.finish();
    const unknown = await open({ version: undefined });
    expect((unknown.created as unknown as { _meta: unknown })._meta).toEqual({
      "armadra.pi": { verified: false, capabilities: NO_EXTRAS },
    });
    expect(unknown.h.stderr.join("")).toMatch(/could not read the pi version/);
    expect(unknown.h.pi.last().unknown).toEqual([]);
  });
});

describe("session/prompt", () => {
  it("文本与思考流成 chunk，end_turn，答复带本回合用量；回合结束再发 usage_update", async () => {
    const { h, id } = await open({
      onPrompt: async (t) => {
        t.think("hmm");
        t.text("hel");
        t.text("lo");
        t.assistantEnd({ text: "hello" });
      },
    });
    await tick(30);
    const result = await h.client.prompt(id, text("hi"));
    expect(result).toEqual({
      stopReason: "end_turn",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedReadTokens: 100,
        cachedWriteTokens: 0,
        totalTokens: 115,
      },
    });
    expect(h.updatesOf("agent_thought_chunk")).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
    ]);
    expect(
      h
        .updatesOf("agent_message_chunk")
        .map((u) => (u["content"] as { text: string }).text)
        .join(""),
    ).toBe("hello");
    expect(h.pi.last().commands.find((c) => c["type"] === "prompt")).toMatchObject({
      message: "hi",
    });
  });

  it("图片走 images，资源包进 message", async () => {
    const { h, id } = await open();
    await h.client.prompt(id, [
      { type: "text", text: "look" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "resource_link", uri: "file:///a.ts", name: "a.ts" },
      { type: "resource", resource: { uri: "file:///b.ts", text: "body" } },
    ]);
    expect(h.pi.last().commands.find((c) => c["type"] === "prompt")).toMatchObject({
      message: 'look\n@file:///a.ts\n<resource uri="file:///b.ts">\nbody\n</resource>',
      images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
  });

  it("账单值：1.5.0 的 usage_update 标 fromProvider，1.4.0 不标", async () => {
    const billed = {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { total: 0.5, totalFromProvider: 0.5 },
    };
    let tokens = 0;
    for (const [version, expected] of [
      ["1.5.0", [{ "armadra.pi": { fromProvider: true } }]],
      ["1.4.0", [undefined]],
    ] as const) {
      const { h, id } = await open({
        version,
        onPrompt: async (t) => t.assistantEnd({ usage: billed }),
        stats: () => ({ cost: 0.5, contextUsage: { tokens: (tokens += 50), contextWindow: 1000 } }),
      });
      await tick(30);
      await h.client.prompt(id, text("x"));
      const metas = h
        .updatesOf("usage_update")
        .slice(1)
        .map((u) => u["_meta"]);
      expect(metas).toEqual(expected);
      await h.finish();
    }
  });

  it("disposition 为 handled：不等回合，end_turn", async () => {
    const { h, id } = await open({ disposition: "handled" });
    expect(await h.client.prompt(id, text("/cmd"))).toEqual({ stopReason: "end_turn" });
  });

  it("stopReason：length → max_tokens；error → JSON-RPC 错误", async () => {
    const length = await open({ onPrompt: async (t) => t.assistantEnd({ stopReason: "length" }) });
    expect((await length.h.client.prompt(length.id, text("x"))).stopReason).toBe("max_tokens");
    await length.h.finish();
    const failing = await open({
      onPrompt: async (t) => t.assistantEnd({ stopReason: "error", errorMessage: "rate limited" }),
    });
    const error = await rejection(failing.h.client.prompt(failing.id, text("x")));
    expect(error.message).toContain("rate limited");
  });

  it("运行中再来的 prompt 答 busy，不影响在跑的回合", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { h, id } = await open({
      onPrompt: async (t) => {
        await gate;
        t.assistantEnd({});
      },
    });
    const first = h.client.prompt(id, text("a"));
    await tick(30);
    const error = await rejection(h.client.prompt(id, text("b")));
    expect(error.message).toMatch(/already running/);
    release();
    expect((await first).stopReason).toBe("end_turn");
  });

  it("session/cancel：发 abort，回合以 cancelled 结束", async () => {
    const { h, id } = await open({
      onPrompt: async (t) => {
        t.text("working");
        await t.aborted;
      },
    });
    const running = h.client.prompt(id, text("long"));
    await tick(30);
    await h.client.cancel(id);
    expect((await running).stopReason).toBe("cancelled");
    expect(h.commandsOf("abort")).toBe(1);
  });

  it("取消后 pi 不停：15 秒看门狗（这里 200 ms）关进程", async () => {
    const { h, id } = await open({
      onPrompt: async () => {
        await new Promise(() => undefined);
      },
      ignoreAbort: true,
    });
    const running = h.client.prompt(id, text("stuck"));
    await tick(30);
    await h.client.cancel(id);
    const error = await rejection(running);
    expect(error.message).toMatch(/pi exited/);
    expect(h.stderr.join("")).toMatch(/grace period/);
  });

  it("pi 回合中途退出：prompt 答错误", async () => {
    const { h, id } = await open({
      onPrompt: async () => {
        await new Promise(() => undefined);
      },
    });
    const running = h.client.prompt(id, text("x"));
    await tick(30);
    await h.pi.last().mem.transport.terminate();
    expect((await rejection(running)).message).toMatch(/pi exited/);
  });
});

describe("模型与推理强度", () => {
  it("换模型：set_model，重取推理强度，发 config_option_update；不支持推理的模型没有 thought_level", async () => {
    const { h, id } = await open();
    await tick(30);
    const result = await h.client.setConfigOption(id, "model", "fakeco/beta");
    expect(h.pi.last().commands.find((c) => c["type"] === "set_model")).toMatchObject({
      provider: "fakeco",
      modelId: "beta",
    });
    expect(result.configOptions?.map((o) => o.id)).toEqual(["model"]);
    expect(result.configOptions?.[0]?.currentValue).toBe("fakeco/beta");
    await tick(20);
    expect(h.updatesOf("config_option_update")).toHaveLength(1);
    // 换模型之后用量也要刷新
    expect(h.updatesOf("usage_update").at(-1)).toMatchObject({ size: 100000 });
  });

  it("模型 id 里带斜杠也能选", async () => {
    const { h, id } = await open();
    const result = await h.client.setConfigOption(id, "model", "other/gamma/1");
    expect(result.configOptions?.[0]?.currentValue).toBe("other/gamma/1");
  });

  it("推理强度：set_thinking_level；无效值与未知配置项答 -32602", async () => {
    const { h, id } = await open();
    const result = await h.client.setConfigOption(id, "thought_level", "high");
    expect(h.pi.last().commands.find((c) => c["type"] === "set_thinking_level")).toMatchObject({
      level: "high",
    });
    expect(result.configOptions?.find((o) => o.id === "thought_level")?.currentValue).toBe("high");
    expect((await rejection(h.client.setConfigOption(id, "thought_level", "max"))).code).toBe(
      -32602,
    );
    expect((await rejection(h.client.setConfigOption(id, "model", "nope/x"))).code).toBe(-32602);
    expect((await rejection(h.client.setConfigOption(id, "color", "red"))).code).toBe(-32602);
  });

  it("模型清单没有当前模型时补进去", async () => {
    const { created } = await open({ models: FAKE_MODELS.slice(1), model: FAKE_MODELS[0]! });
    const groups = created.configOptions![0]!.options as { options: { value: string }[] }[];
    expect(groups.flatMap((g) => g.options.map((o) => o.value))).toContain("fakeco/alpha");
  });
});

describe("session/load 与 session/resume", () => {
  const history = [
    { role: "user", content: "list files" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "sure" },
        { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "t1",
      content: [{ type: "text", text: "a.txt" }],
      isError: false,
    },
  ];

  it("load 回放历史：用户 / 思考 / 文本 / 终态的工具调用", async () => {
    h = await bridgeHarness({ pi: { messages: history } });
    await h.client.initialize();
    await h.client.loadSession("11111111-1111-4111-8111-111111111111", CWD);
    expect(h.pi.last().spec.args).toContain("11111111-1111-4111-8111-111111111111");
    expect(h.updates.map((n) => n.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_thought_chunk",
      "agent_message_chunk",
      "tool_call",
    ]);
    expect(h.updatesOf("tool_call")[0]).toMatchObject({
      toolCallId: "t1",
      title: "$ ls",
      kind: "execute",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "a.txt" } }],
    });
  });

  it("resume 不回放；同一会话已开着时直接返回", async () => {
    h = await bridgeHarness({ pi: { messages: history } });
    await h.client.initialize();
    const id = "22222222-2222-4222-8222-222222222222";
    await h.client.resumeSession(id, CWD);
    expect(h.updates.filter((n) => n.update.sessionUpdate !== "usage_update")).toEqual([]);
    await h.client.resumeSession(id, CWD);
    expect(h.pi.instances).toHaveLength(1);
  });

  it("Pi 里没有这个会话（messageCount 为 0，Pi 会静默新建）：-32002，进程收掉", async () => {
    h = await bridgeHarness();
    await h.client.initialize();
    for (const call of [
      () => h!.client.loadSession("33333333-3333-4333-8333-333333333333", CWD),
      () => h!.client.resumeSession("33333333-3333-4333-8333-333333333333", CWD),
    ]) {
      const error = await rejection(call());
      expect(error.code).toBe(-32002);
    }
    for (const instance of h.pi.instances) await instance.mem.done;
  });
});

describe("工具调用", () => {
  it("开始 → 进度 → 结束：tool_call、tool_call_update；位置取参数里的路径", async () => {
    const { h, id } = await open({
      onPrompt: async (t) => {
        await t.tool({
          id: "c1",
          name: "read",
          args: { path: "src/a.ts" },
          partials: [{ content: [{ type: "text", text: "par" }] }],
          result: { content: [{ type: "text", text: "contents" }] },
        });
        t.assistantEnd({});
      },
    });
    await h.client.prompt(id, text("read it"));
    const kinds = h.updates
      .map((n) => n.update)
      .filter((u) => u.sessionUpdate.startsWith("tool_call"))
      .map((u) => [u.sessionUpdate, (u as { status?: string }).status]);
    expect(kinds).toEqual([
      ["tool_call", "in_progress"],
      ["tool_call_update", "in_progress"],
      ["tool_call_update", "completed"],
    ]);
    expect(h.updatesOf("tool_call")[0]).toMatchObject({
      toolCallId: "c1",
      title: "read src/a.ts",
      kind: "read",
      name: "read",
      rawInput: { path: "src/a.ts" },
    });
    const last = h.updatesOf("tool_call_update").at(-1);
    expect(last).toMatchObject({
      content: [{ type: "content", content: { type: "text", text: "contents" } }],
    });
  });

  it("codemode 里发起的内层调用带 _meta.ama.parentToolCallId；失败的调用 status 为 failed", async () => {
    const { h, id } = await open({
      onPrompt: async (t) => {
        await t.tool({
          id: "outer/1",
          name: "bash",
          args: { command: "x" },
          parent: "outer",
          isError: true,
        });
        t.assistantEnd({});
      },
    });
    await h.client.prompt(id, text("go"));
    expect(h.updatesOf("tool_call")[0]).toMatchObject({
      _meta: { ama: { parentToolCallId: "outer" } },
    });
    expect(h.updatesOf("tool_call_update").at(-1)).toMatchObject({ status: "failed" });
  });
});
