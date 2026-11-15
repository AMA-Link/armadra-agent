import { afterEach, describe, expect, it, vi } from "vitest";
import { collectEvents } from "../event-stream.js";
import type {
  AssistantMessage,
  Model,
  StreamOptions,
  ToolDecl,
  TranscriptContext,
} from "../types.js";
import { anthropicMessagesApi } from "./anthropic-messages.js";
import { MESSAGE_THREADS_BETA } from "./anthropic-request.js";
import { forgetThreads, threadStateOf } from "./anthropic-threads.js";

const model: Model = {
  id: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  input: ["text"],
  reasoning: false,
  contextWindow: 200_000,
  maxTokens: 8000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  authHeader: "x-api-key",
  requiresApiKey: true,
};

const TOOL: ToolDecl = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

interface Wire {
  model?: string;
  system?: unknown;
  tools?: unknown;
  messages: { role: string; content: unknown }[];
  thread?: { type: string; previous_message_id?: string };
}

interface Seen {
  body: Wire;
  betas: string[];
}

type Responder = (seen: Seen) => Response;

function sse(id: string, content: "text" | "tool", usage: Record<string, number> = {}): Response {
  const events: [string, unknown][] = [
    [
      "message_start",
      { type: "message_start", message: { id, usage: { input_tokens: 5, ...usage } } },
    ],
  ];
  if (content === "text") {
    events.push(
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: `reply ${id}` },
        },
      ],
    );
  } else {
    events.push(
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig==" },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
    );
  }
  if (content === "text")
    events.push(["content_block_stop", { type: "content_block_stop", index: 0 }]);
  events.push(
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: content === "tool" ? "tool_use" : "end_turn" },
        usage: { output_tokens: 7 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  );
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function reject(code: string | undefined, message = "rejected", status = 400): Response {
  const error = {
    type: "invalid_request_error",
    message,
    ...(code ? { details: { error_code: code } } : {}),
  };
  return new Response(JSON.stringify({ type: "error", error }), { status });
}

let counter = 0;

function harness() {
  const seen: Seen[] = [];
  const queue: Responder[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Wire;
    const beta = new Headers(init?.headers).get("anthropic-beta");
    const entry = { body, betas: beta ? beta.split(",") : [] };
    seen.push(entry);
    const next = queue.shift();
    return next ? next(entry) : sse(`msg_${seen.length}`, "text", { cache_read_input_tokens: 100 });
  });
  const sessionId = `threads-${++counter}`;
  return { seen, queue, sessionId };
}

afterEach(() => {
  vi.unstubAllGlobals();
  forgetThreads();
});

function context(
  messages: TranscriptContext["messages"],
  opts: { system?: string; tools?: ToolDecl[] } = {},
): TranscriptContext {
  return {
    messages: [
      {
        role: "system",
        sections: { preamble: opts.system ?? "You are a test assistant." },
        ...(opts.tools ? { toolsAdded: opts.tools } : {}),
        timestamp: 0,
      },
      ...messages,
    ],
  };
}

async function send(
  ctx: TranscriptContext,
  options: Partial<StreamOptions> & { sessionId?: string },
  m: Model = model,
): Promise<AssistantMessage> {
  const stream = anthropicMessagesApi.stream(m, ctx, {
    signal: new AbortController().signal,
    apiKey: "sk-test",
    ...options,
  });
  const events = await collectEvents(stream);
  const last = events.at(-1);
  if (last?.type !== "done") throw new Error(`stream ended with ${last?.type}`);
  return last.message;
}

const user = (text: string, ts = 1) => ({ role: "user" as const, content: text, timestamp: ts });

describe("anthropic message threads：续接", () => {
  it("首条整请求带 create 与 beta 头；第二条只发新增消息并 continue 上一条回复", async () => {
    const { seen, sessionId } = harness();
    const first = await send(context([user("q1")], { tools: [TOOL] }), { sessionId });
    expect(seen[0]?.betas).toContain(MESSAGE_THREADS_BETA);
    expect(seen[0]?.body.thread).toEqual({ type: "create" });
    expect(seen[0]?.body.system).toBeDefined();
    expect(seen[0]?.body.tools).toBeDefined();
    expect(first.responseId).toBe("msg_1");

    await send(context([user("q1"), first, user("q2", 3)], { tools: [TOOL] }), { sessionId });
    const second = seen[1]!.body;
    expect(second.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]?.role).toBe("user");
    expect(JSON.stringify(second.messages)).toContain("q2");
    expect("system" in second).toBe(false);
    expect("tools" in second).toBe(false);
    expect(second.model).toBe(model.id);
    expect(seen[1]?.betas).toEqual(seen[0]?.betas);
  });

  it("带思考块与工具调用的回复也能续接，工具结果作为新增消息", async () => {
    const { seen, queue, sessionId } = harness();
    queue.push(() => sse("msg_a", "tool"));
    const ctx1 = context([user("q1")], { tools: [TOOL] });
    const reply = await send(ctx1, { sessionId });
    const result = {
      role: "toolResult" as const,
      toolCallId: "toolu_1",
      toolName: "read",
      content: "file",
      isError: false,
      timestamp: 4,
    };
    await send(context([user("q1"), reply, result], { tools: [TOOL] }), { sessionId });
    expect(seen[1]?.body.thread).toEqual({ type: "continue", previous_message_id: "msg_a" });
    expect(seen[1]?.body.messages).toHaveLength(1);
    expect(JSON.stringify(seen[1]?.body.messages)).toContain("tool_result");
  });

  it("连续多轮：每轮都从上一条回复续接", async () => {
    const { seen, sessionId } = harness();
    let messages: TranscriptContext["messages"] = [user("q0")];
    for (let i = 0; i < 4; i++) {
      const reply = await send(context(messages), { sessionId });
      messages = [...messages, reply, user(`q${i + 1}`, 10 + i)];
    }
    expect(seen.map((s) => s.body.thread?.type)).toEqual([
      "create",
      "continue",
      "continue",
      "continue",
    ]);
    expect(seen[3]?.body.thread?.previous_message_id).toBe("msg_3");
    expect(seen[3]?.body.messages).toHaveLength(1);
  });

  it("用量照常上报（续接不改 token 与缓存字段）", async () => {
    const { queue, sessionId } = harness();
    queue.push(() =>
      sse("m1", "text", { cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }),
    );
    const reply = await send(context([user("q")]), { sessionId });
    expect(reply.usage).toMatchObject({
      input: 5,
      cacheRead: 900,
      cacheWrite: 50,
      cacheReported: true,
    });
  });
});

describe("anthropic message threads：回退整请求", () => {
  async function prime(sessionId: string, tools = [TOOL]) {
    const ctx = context([user("q1"), user("q1b", 2)], { tools });
    const reply = await send(ctx, { sessionId });
    return reply;
  }

  it("压缩 / 回退 / 分支切换（前文变了或变短）→ 整请求新开线程", async () => {
    const { seen, sessionId } = harness();
    const reply = await prime(sessionId);
    // 压缩：旧消息被摘要替换
    await send(context([user("summary of earlier"), user("q2", 5)], { tools: [TOOL] }), {
      sessionId,
    });
    expect(seen[1]?.body.thread).toEqual({ type: "create" });
    expect(seen[1]?.body.messages).toHaveLength(2);
    expect(reply.responseId).toBe("msg_1");
  });

  it("回退到更早的位置（消息数不超过续接点）→ 整请求", async () => {
    const { seen, sessionId } = harness();
    const reply = await prime(sessionId);
    await send(context([user("q1")], { tools: [TOOL] }), { sessionId });
    expect(seen[1]?.body.thread).toEqual({ type: "create" });
    expect(reply).toBeDefined();
  });

  it.each([
    ["模型", { m: { ...model, id: "claude-opus-5" } }],
    ["system", { system: "Other prompt." }],
    ["tools", { tools: [] as ToolDecl[] }],
  ])("%s 变了 → 整请求", async (_name, change) => {
    const { seen, sessionId } = harness();
    const reply = await prime(sessionId);
    const ctx = context([user("q1"), user("q1b", 2), reply, user("q2", 5)], {
      tools: "tools" in change ? change.tools : [TOOL],
      ...("system" in change ? { system: change.system } : {}),
    });
    await send(ctx, { sessionId }, "m" in change ? change.m : model);
    expect(seen[1]?.body.thread).toEqual({ type: "create" });
    expect(seen[1]?.body.messages.length).toBeGreaterThan(1);
  });

  it("thinking 级别变了（固定字段）→ 整请求", async () => {
    const { seen, sessionId } = harness();
    const reasoning: Model = { ...model, reasoning: true, compat: { adaptiveThinking: true } };
    const ctx1 = context([user("q1")]);
    const reply = await send(ctx1, { sessionId, thinkingLevel: "low" }, reasoning);
    await send(
      context([user("q1"), reply, user("q2", 5)]),
      { sessionId, thinkingLevel: "high" },
      reasoning,
    );
    expect(seen[1]?.body.thread).toEqual({ type: "create" });
  });

  it("出错的回合不记续接点 → 下一次整请求", async () => {
    const { seen, queue, sessionId } = harness();
    await send(context([user("q1")]), { sessionId });
    queue.push(() => reject(undefined, "overloaded", 529));
    const failed = anthropicMessagesApi.stream(model, context([user("q1"), user("q2", 3)]), {
      signal: new AbortController().signal,
      apiKey: "sk-test",
      sessionId,
    });
    expect((await collectEvents(failed)).at(-1)?.type).toBe("error");
    expect(threadStateOf(sessionId)).toBeUndefined();
    await send(context([user("q1"), user("q2", 3)]), { sessionId });
    expect(seen.at(-1)?.body.thread).toEqual({ type: "create" });
  });
});

describe("anthropic message threads：服务端拒绝", () => {
  it.each([
    "thread_not_found",
    "thread_already_continued",
    "thread_continue_in_flight",
    "thread_fingerprint_mismatch",
  ])("%s → 整请求新开线程重发一次，之后仍可续接", async (code) => {
    const { seen, queue, sessionId } = harness();
    const r1 = await send(context([user("q1")]), { sessionId });
    queue.push(() => reject(code));
    const ctx2 = context([user("q1"), r1, user("q2", 3)]);
    const r2 = await send(ctx2, { sessionId });
    expect(seen).toHaveLength(3);
    expect(seen[1]?.body.thread?.type).toBe("continue");
    expect(seen[2]?.body.thread).toEqual({ type: "create" });
    expect(seen[2]?.body.messages).toHaveLength(3);
    expect(seen[2]?.body.system).toBeDefined();
    await send(context([user("q1"), r1, user("q2", 3), r2, user("q3", 5)]), { sessionId });
    expect(seen[3]?.body.thread).toEqual({ type: "continue", previous_message_id: r2.responseId });
  });

  it("thread_unsupported_request → 去掉 thread 整请求重发，会话之后不再带 thread（beta 头照发）", async () => {
    const { seen, queue, sessionId } = harness();
    queue.push(() => reject("thread_unsupported_request"));
    const r1 = await send(context([user("q1")]), { sessionId });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.body.thread).toEqual({ type: "create" });
    expect("thread" in seen[1]!.body).toBe(false);
    expect(threadStateOf(sessionId)).toBe("off");
    await send(context([user("q1"), r1, user("q2", 3)]), { sessionId });
    expect("thread" in seen[2]!.body).toBe(false);
    expect(seen[2]?.body.messages).toHaveLength(3);
    expect(seen[2]?.betas).toContain(MESSAGE_THREADS_BETA);
  });

  it("端点不认 thread 字段（无错误码的 400）→ 同样去掉 thread 重发并关掉线程", async () => {
    const { seen, queue, sessionId } = harness();
    queue.push(() => reject(undefined, "thread: Extra inputs are not permitted"));
    await send(context([user("q1")]), { sessionId });
    expect(seen).toHaveLength(2);
    expect("thread" in seen[1]!.body).toBe(false);
    expect(threadStateOf(sessionId)).toBe("off");
  });

  it("与线程无关的 400 原样报错，不重发", async () => {
    const { seen, queue, sessionId } = harness();
    queue.push(() => reject(undefined, "prompt is too long: 250000 tokens > 200000 maximum"));
    const stream = anthropicMessagesApi.stream(model, context([user("q1")]), {
      signal: new AbortController().signal,
      apiKey: "sk-test",
      sessionId,
    });
    const last = (await collectEvents(stream)).at(-1);
    expect(last?.type).toBe("error");
    expect(seen).toHaveLength(1);
  });
});

describe("anthropic message threads：不参与线程的请求", () => {
  it("disableContinuation：不带 thread，也不替换真实回合的续接点", async () => {
    const { seen, sessionId } = harness();
    const ctx1 = context([user("q1")]);
    const r1 = await send(ctx1, { sessionId });
    // 保温重放：同上下文整段前缀，maxTokens 1
    await send(ctx1, { sessionId, disableContinuation: true, purpose: "warm", maxTokens: 1 });
    expect("thread" in seen[1]!.body).toBe(false);
    expect(seen[1]?.body.messages).toHaveLength(1);
    expect(seen[1]?.betas).toEqual(seen[0]?.betas); // 与真实请求头一致，保缓存键
    await send(context([user("q1"), r1, user("q2", 3)]), { sessionId });
    expect(seen[2]?.body.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
  });

  it("没有 disableContinuation 时 summary / warm / probe / classify 用途也不碰线程", async () => {
    const { seen, sessionId } = harness();
    const r1 = await send(context([user("q1")]), { sessionId });
    for (const purpose of ["summary", "warm", "probe", "classify"] as const) {
      await send(context([user("q1"), r1, user("sum", 3)]), { sessionId, purpose });
    }
    expect(seen.slice(1).every((s) => !("thread" in s.body))).toBe(true);
    await send(context([user("q1"), r1, user("q2", 3)]), { sessionId });
    expect(seen.at(-1)?.body.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
  });

  it("没有 sessionId / cacheRetention none → 不带线程 beta 与 thread", async () => {
    const { seen, sessionId } = harness();
    await send(context([user("q1")]), {});
    await send(context([user("q1")]), { sessionId, cacheRetention: "none" });
    for (const entry of seen) {
      expect(entry.betas).not.toContain(MESSAGE_THREADS_BETA);
      expect("thread" in entry.body).toBe(false);
    }
  });

  it("compat.messageThreads:false 关闭；第三方端点缺省关，显式 true 才开", async () => {
    const { seen, sessionId } = harness();
    await send(
      context([user("q")]),
      { sessionId },
      { ...model, compat: { messageThreads: false } },
    );
    const relay: Model = { ...model, baseUrl: "https://relay.example.test" };
    await send(context([user("q")]), { sessionId }, relay);
    await send(context([user("q")]), { sessionId }, { ...relay, compat: { messageThreads: true } });
    expect(seen.map((s) => s.betas.includes(MESSAGE_THREADS_BETA))).toEqual([false, false, true]);
    expect(seen.map((s) => "thread" in s.body)).toEqual([false, false, true]);
  });
});
