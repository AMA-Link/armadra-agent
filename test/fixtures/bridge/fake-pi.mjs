// 独立的假 pi（bundle 级 e2e 用，#254）：`--version` 答 FAKE_PI_VERSION；`--mode rpc` 说最小的 JSONL RPC。
// 收到的命令追加写进 FAKE_PI_LOG（每行一条 JSON），供测试断言桥发了什么。
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_PI_VERSION ?? "1.5.0"}\n`);
  process.exit(0);
}
const log = (record) => process.env.FAKE_PI_LOG && appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify(record)}\n`);
log({ argv });
const sessionId = argv[argv.indexOf("--session-id") + 1] ?? "fake-session";
const model = { provider: "fakeco", id: "alpha", name: "Alpha", reasoning: true, contextWindow: 1000 };
const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const reply = (cmd, data) =>
  out({ id: cmd.id, type: "response", command: cmd.type, success: true, ...(data ? { data } : {}) });
createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  if (cmd.type === "extension_ui_response") return log(cmd);
  log(cmd);
  switch (cmd.type) {
    case "get_state":
      return reply(cmd, { model, thinkingLevel: "medium", sessionId, messageCount: 0 });
    case "get_available_models":
      return reply(cmd, { models: [model] });
    case "get_available_thinking_levels":
      return reply(cmd, { levels: ["off", "medium"] });
    case "get_session_stats":
      return reply(cmd, { cost: 0.01, contextUsage: { tokens: 10, contextWindow: 1000 } });
    case "prompt":
      reply(cmd, { disposition: "started" });
      out({ type: "agent_start" });
      out({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `echo: ${cmd.message}` },
      });
      out({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "x" }],
          stopReason: "stop",
          usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0.01 } },
        },
      });
      return out({ type: "agent_settled", aborted: false });
    default:
      return reply(cmd);
  }
}).on("close", () => process.exit(0));
