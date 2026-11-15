/**
 * Anthropic message threads（beta `message-threads-2026-08-12`，docs/guides/providers.md「消息线程」）。
 *
 * 服务端按线程保存对话：带稳定 `sessionId` 且开着提示缓存的请求，在上一条回复之后只需发新增消息。
 * 线上形状：
 * - 首条（或无法续接时）整请求发出，加 `thread: { type: "create" }`；
 * - 续接：去掉 `system` / `tools`（服务端沿用线程里的），`messages` 只留新增部分，加
 *   `thread: { type: "continue", previous_message_id: <上一条回复的 message id> }`；
 * - 拒收带 `error.details.error_code`：`thread_not_found` / `thread_already_continued` /
 *   `thread_continue_in_flight` / `thread_fingerprint_mismatch` → 整请求新开线程重发一次；
 *   `thread_unsupported_request`，或没有错误码但 400 文案点名 `thread`（端点不认该字段）→ 去掉
 *   `thread` 整请求重发一次，重发请求同时去掉线程 beta 头（端点可能连该头的值都拒收），并把该会话与
 *   该端点 + 模型在本进程内关掉线程（之后的请求不再带头，也不再多吃一次 400）。其它错误与线程无关，原样抛出。
 *
 * 每个会话只记最近一次回复的续接点（一条回复只能续接一次）：取用即删，并发请求只会各自新开线程。
 * 续接点只在「线程内的前文与本次请求逐项一致」时使用：哈希覆盖端点、模型、system、tools、
 * thinking、output_config、tool_choice、beta 与已有消息（忽略 cache_control 位置与字符串 / 文本块写法）。
 * 压缩、回退 / 分支切换、改模型 / system / tools 都会让哈希不一致，改走整请求并新开线程。
 * token 用量与缓存读写仍按整段对话报告，指纹与未命中检测只看转录，不受续接影响。
 */

import { HttpError } from "../http.js";
import { hash16 } from "../cache/fingerprint.js";

type Json = Record<string, unknown>;

export const MESSAGE_THREADS_BETA = "message-threads-2026-08-12";

/** 会话状态表容量；超出时丢最久未用的会话（它的线程多半已在服务端过期，丢了只是下次新开）。 */
export const MAX_THREAD_SESSIONS = 10_000;

interface ThreadEntry {
  /** 线程已持有的消息条数（含上一条回复）。 */
  prefixCount: number;
  prefixHash: string;
  replyId: string;
}

const threadState = new Map<string, ThreadEntry | "off">();

/** 已确认不支持线程的端点 + 模型（本进程内）；容量有限，超出丢最旧的。 */
const offEndpoints = new Set<string>();
const MAX_OFF_ENDPOINTS = 1000;

export function threadEndpointKey(provider: string, baseUrl: string, modelId: unknown): string {
  return JSON.stringify([provider, baseUrl, modelId]);
}

function markEndpointOff(endpoint: string): void {
  offEndpoints.delete(endpoint);
  offEndpoints.add(endpoint);
  if (offEndpoints.size > MAX_OFF_ENDPOINTS) {
    const oldest = offEndpoints.values().next().value;
    if (oldest !== undefined) offEndpoints.delete(oldest);
  }
}

/** 该端点 + 模型或该线程键已被关掉线程：请求既不带线程字段，也不带线程 beta 头。 */
export function threadsDisabled(endpoint: string, threadKey: string | undefined): boolean {
  return (
    offEndpoints.has(endpoint) || (threadKey !== undefined && threadState.get(threadKey) === "off")
  );
}

function setState(sessionId: string, value: ThreadEntry | "off"): void {
  threadState.delete(sessionId);
  threadState.set(sessionId, value);
  if (threadState.size > MAX_THREAD_SESSIONS) {
    const oldest = threadState.keys().next().value;
    if (oldest !== undefined) threadState.delete(oldest);
  }
}

/** 忘掉一个会话的线程状态（会话结束时调用）；不传清空全部。 */
export function forgetThreads(sessionId?: string): void {
  if (sessionId === undefined) {
    threadState.clear();
    offEndpoints.clear();
  } else threadState.delete(sessionId);
}

/** 测试用：会话当前的状态。 */
export function threadStateOf(sessionId: string): "off" | "continuable" | undefined {
  const state = threadState.get(sessionId);
  return state === undefined ? undefined : state === "off" ? "off" : "continuable";
}

export interface ThreadContext {
  provider: string;
  baseUrl: string;
  betas: readonly string[];
}

/** 线程依赖的一切：固定字段（同线程内不可变）+ 已有消息（规整后）。 */
function hashPrefix(ctx: ThreadContext, body: Json, messages: readonly unknown[]): string {
  const settings = JSON.stringify([
    ctx.provider,
    ctx.baseUrl,
    body["model"],
    body["system"],
    body["tools"],
    body["thinking"],
    body["output_config"],
    body["tool_choice"],
    ctx.betas,
  ]);
  // cache_control 会随「最新消息」移动；最新 user 消息的字符串内容为挂断点会写成单个文本块，
  // 下一次请求又是字符串：两种写法含义相同，哈希前统一。
  const conversation = JSON.stringify(messages, (key, value: unknown) => {
    if (key === "cache_control") return undefined;
    if (key === "content" && typeof value === "string") return [{ type: "text", text: value }];
    return value;
  });
  return hash16(settings + conversation);
}

export interface ThreadRequest {
  /** 线程键（缺省 sessionId；fork 会话用自己的 id）。 */
  sessionId: string;
  endpoint: string;
  body: Json;
}

function createRequest(sessionId: string, endpoint: string, body: Json): ThreadRequest {
  return { sessionId, endpoint, body: { ...body, thread: { type: "create" } } };
}

/** 本次请求的线程形态；会话已被关掉线程时返回 undefined（发普通请求）。 */
export function prepareThread(
  ctx: ThreadContext,
  sessionId: string,
  body: Json,
): ThreadRequest | undefined {
  const endpoint = threadEndpointKey(ctx.provider, ctx.baseUrl, body["model"]);
  const state = threadState.get(sessionId);
  if (state === "off" || offEndpoints.has(endpoint)) return undefined;
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as unknown[]) : [];
  if (
    state !== undefined &&
    messages.length > state.prefixCount &&
    hashPrefix(ctx, body, messages.slice(0, state.prefixCount)) === state.prefixHash
  ) {
    // 取用即删：一条回复只能续接一次，也挡住并发请求重复续接。
    threadState.delete(sessionId);
    const { system: _system, tools: _tools, ...rest } = body;
    return {
      sessionId,
      endpoint,
      body: {
        ...rest,
        messages: messages.slice(state.prefixCount),
        thread: { type: "continue", previous_message_id: state.replyId },
      },
    };
  }
  threadState.delete(sessionId);
  return createRequest(sessionId, endpoint, body);
}

const NEW_THREAD_CODES: ReadonlySet<string> = new Set([
  "thread_not_found",
  "thread_already_continued",
  "thread_continue_in_flight",
  "thread_fingerprint_mismatch",
]);

/** 拒收体里的 `error.details.error_code`。 */
export function threadErrorCode(error: unknown): string | undefined {
  if (!(error instanceof HttpError)) return undefined;
  try {
    const parsed = JSON.parse(error.body) as { error?: { details?: { error_code?: unknown } } };
    const code = parsed.error?.details?.error_code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/** `new`：整请求新开线程重发；`unsupported`：去掉 thread 重发并关掉该会话；undefined：与线程无关。 */
export function classifyThreadError(error: unknown): "new" | "unsupported" | undefined {
  if (!(error instanceof HttpError)) return undefined;
  const code = threadErrorCode(error);
  if (code !== undefined && NEW_THREAD_CODES.has(code)) return "new";
  if (code === "thread_unsupported_request") return "unsupported";
  // 端点不认 `thread` 字段（Extra inputs are not permitted）时没有错误码。
  if (code === undefined && error.status === 400 && /thread/i.test(`${error.message}${error.body}`))
    return "unsupported";
  return undefined;
}

export interface SentThread {
  response: Response;
  /** 产出该响应的线程请求；undefined = 最终发的是不带 thread 的普通请求。 */
  thread: ThreadRequest | undefined;
}

/**
 * 发线程请求；被线程相关的 400 拒收（流未开始）时整请求重发一次。重发后的错误照常抛出。
 * `full` 是未改动的整请求体。
 */
export async function sendThreadRequest(
  thread: ThreadRequest,
  full: Json,
  send: (body: Json, dropThreadBeta?: boolean) => Promise<Response>,
  signal: AbortSignal,
): Promise<SentThread> {
  try {
    return { response: await send(thread.body), thread };
  } catch (error) {
    const action = signal.aborted ? undefined : classifyThreadError(error);
    if (action === undefined) throw error;
    if (action === "new") {
      const created = createRequest(thread.sessionId, thread.endpoint, full);
      return { response: await send(created.body), thread: created };
    }
    // 先关再发：重发也失败时，同会话的下一次请求不再重复尝试
    setState(thread.sessionId, "off");
    markEndpointOff(thread.endpoint);
    const response = await send(full, true);
    return { response, thread: undefined };
  }
}

/**
 * 记下下一次请求的续接点：`reply` 是线程请求 `thread` 的干净回复（已转成请求消息形状），
 * `full` 是该次的整请求体。
 */
export function recordThreadReply(
  ctx: ThreadContext,
  thread: ThreadRequest,
  full: Json,
  replyId: string | undefined,
  reply: readonly unknown[],
): void {
  if (replyId === undefined || replyId === "") return;
  const messages = Array.isArray(full["messages"]) ? (full["messages"] as unknown[]) : [];
  const prefix = [...messages, ...reply];
  setState(thread.sessionId, {
    prefixCount: prefix.length,
    prefixHash: hashPrefix(ctx, full, prefix),
    replyId,
  });
}
