#!/usr/bin/env node
// Anthropic message threads 手工实测（真 key，会花一点钱；CI 与测试都不跑）。
//
//   pnpm build:lib && ANTHROPIC_API_KEY=sk-ant-... node scripts/verify-anthropic-threads.mjs [模型 id]
//
// 缺省模型 claude-haiku-5-5。key 只从环境变量读，不打印、不落盘；AMA_DATA_DIR / AMA_CONFIG_DIR 指向
// 临时目录，不碰真实数据。用构建后的 dist/ 的 Anthropic 协议层连发 3 轮对话（同一 sessionId，开提示缓存），
// 每轮报告：线程动作（create / continue / 无）、请求体消息条数、input / cacheRead / cacheWrite / output。
// 第 2 轮没有 continue 时退出码 1（端点不支持线程、被回落整请求、或前文哈希不一致）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) {
  process.stderr.write("需要环境变量 ANTHROPIC_API_KEY\n");
  process.exit(2);
}
const modelId = process.argv[2] ?? "claude-haiku-5-5";

const temp = mkdtempSync(join(tmpdir(), "ama-verify-threads-"));
process.env["AMA_DATA_DIR"] = join(temp, "data");
process.env["AMA_CONFIG_DIR"] = join(temp, "config");

const load = (path) => import(pathToFileURL(join(root, "dist", path)).href);
let api;
let events;
try {
  api = (await load("ai/apis/anthropic-messages.js")).anthropicMessagesApi;
  events = await load("ai/event-stream.js");
} catch {
  process.stderr.write("找不到 dist/，先运行 pnpm build:lib\n");
  rmSync(temp, { recursive: true, force: true });
  process.exit(2);
}

/** 记录每个请求的线程动作与消息条数；不记头与 key。 */
const wire = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  try {
    const body = JSON.parse(String(init?.body ?? "{}"));
    wire.push({
      thread: body.thread?.type ?? "none",
      messages: Array.isArray(body.messages) ? body.messages.length : 0,
      hasSystem: body.system !== undefined,
    });
  } catch {
    wire.push({ thread: "unknown", messages: 0, hasSystem: false });
  }
  return realFetch(url, init);
};

const model = {
  id: modelId,
  name: modelId,
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: process.env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com",
  input: ["text"],
  reasoning: false,
  contextWindow: 200_000,
  maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  authHeader: "x-api-key",
  requiresApiKey: true,
  compat: { messageThreads: true },
};

// 前缀要够长才会写缓存；固定文本，保证三轮字节一致。
const preamble =
  "You are a terse assistant used for an automated API check. Answer in one short sentence. " +
  "Reference notes: " +
  Array.from({ length: 400 }, (_, i) => `note ${i}: the value of item ${i} is ${i * 7}.`).join(" ");
const questions = ["What is 2 + 2?", "And that plus 3?", "And that times 2?"];
const sessionId = `verify-threads-${Date.now()}`;
const messages = [];
const rows = [];

for (let turn = 0; turn < questions.length; turn++) {
  messages.push({ role: "user", content: questions[turn], timestamp: Date.now() });
  const context = {
    messages: [{ role: "system", sections: { preamble }, timestamp: 0 }, ...messages],
  };
  const before = wire.length;
  const stream = api.stream(model, context, {
    signal: new AbortController().signal,
    apiKey,
    sessionId,
    cacheRetention: "short",
    maxTokens: 256,
  });
  const all = await events.collectEvents(stream);
  const last = all.at(-1);
  if (last?.type !== "done") {
    const reason = last?.type === "error" ? (last.error?.errorMessage ?? "error") : last?.type;
    process.stderr.write(`第 ${turn + 1} 轮失败：${String(reason).slice(0, 300)}\n`);
    rmSync(temp, { recursive: true, force: true });
    process.exit(1);
  }
  messages.push(last.message);
  const sent = wire.slice(before);
  const final = sent.at(-1) ?? { thread: "none", messages: 0 };
  rows.push({
    turn: turn + 1,
    requests: sent.length,
    thread: final.thread,
    messages: final.messages,
    input: last.message.usage.input,
    cacheRead: last.message.usage.cacheRead,
    cacheWrite: last.message.usage.cacheWrite,
    output: last.message.usage.output,
  });
}

rmSync(temp, { recursive: true, force: true });
console.table(rows);
const ok = rows[1]?.thread === "continue" && rows[1].messages < 3;
process.stdout.write(
  ok
    ? "OK：第 2 轮用 continue 续接线程\n"
    : "失败：第 2 轮没有续接（thread 动作见上表；请求被回落时 requests 会大于 1）\n",
);
process.exit(ok ? 0 : 1);
