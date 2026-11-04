/**
 * 脚本化的假 Pi（`pi --mode rpc` 的进程内对端，#254）：给 ACP 桥的测试用。
 *
 * - `--version` 按场景答（`version: undefined` 读不出）；PATH 上的 `pi` 由注入的 `ProgramProbe` 顶替；
 * - 说 JSONL RPC：`get_state`、模型与推理强度、`get_session_stats`、`get_messages`、`prompt`（按剧本发事件与
 *   `extension_ui_request`）、`abort`；**不认识的命令像旧版 Pi 那样答一条不带 id 的 parse 失败**，并记进
 *   `unknown`，测试据此断言桥从不发表外命令；
 * - 记下每次 spawn 的参数、收到的全部命令与扩展 UI 应答；`-e` 指向的扩展文件在 spawn 时读一份快照。
 */

import { readFileSync } from "node:fs";
import { ProgramProbe } from "../../src/drivers/probe.js";
import {
  memoryTransport,
  type MemoryTransport,
  type WireLine,
} from "../../src/drivers/test-support.js";
import type { SpawnTransport, TransportSpec } from "../../src/drivers/process.js";
import { createLineReader } from "../../src/modes/rpc/jsonl.js";

type Json = Record<string, unknown>;

export const FAKE_MODELS: Json[] = [
  { provider: "fakeco", id: "alpha", name: "Alpha", reasoning: true, contextWindow: 200000 },
  { provider: "fakeco", id: "beta", name: "Beta", reasoning: false, contextWindow: 100000 },
  { provider: "other", id: "gamma/1", name: "Gamma", reasoning: true, contextWindow: 50000 },
];

export interface FakePiTurn {
  /** `prompt` 命令的 message / images。 */
  message: string;
  images: Json[] | undefined;
  emit(record: Json): void;
  text(delta: string): void;
  think(delta: string): void;
  /** assistant 的 `message_end`（带 usage / stopReason）。 */
  assistantEnd(options?: {
    text?: string;
    stopReason?: string;
    errorMessage?: string;
    usage?: Json;
  }): void;
  /** 一次工具调用；`gate` 模拟审批闸扩展：先发 confirm 对话框，没批准就不执行。 */
  tool(options: {
    id: string;
    name: string;
    args?: Json;
    result?: Json;
    isError?: boolean;
    parent?: string;
    partials?: Json[];
    gate?: Json;
  }): Promise<boolean>;
  /** 发一个扩展 UI 请求并等 `extension_ui_response`（fire-and-forget 方法立即 resolve 为 `{}`）。 */
  ui(request: Json): Promise<Json>;
  /** 收到 `abort` 时 resolve。 */
  aborted: Promise<void>;
  settle(aborted?: boolean): void;
}

export interface FakePiConfig {
  /** `pi --version` 的版本；undefined 表示读不出。缺省 1.5.0。 */
  version?: string | undefined;
  models?: Json[];
  /** 当前模型（缺省第一个；null 表示没选）。 */
  model?: Json | null;
  levels?: string[];
  thinkingLevel?: string;
  /** 已有的会话消息（load / resume）；非空时 `messageCount` 随之。 */
  messages?: Json[];
  /** `prompt` 应答的 disposition（缺省 started）。 */
  disposition?: string;
  stats?: () => Json;
  onPrompt?: (turn: FakePiTurn) => Promise<void>;
  /** 让这条命令永远不回（模拟卡死）。 */
  hangOn?: string;
  /** 收到 `abort` 只应答、不结束回合（模拟停不下来的 pi）。 */
  ignoreAbort?: boolean;
  /** PATH 上没有 `pi`。 */
  missing?: boolean;
}

export interface FakePiInstance {
  spec: TransportSpec;
  mem: MemoryTransport;
  /** 收到的命令（不含 extension_ui_response）。 */
  commands: Json[];
  uiResponses: Json[];
  /** 不认识的命令（桥发了表外命令）。 */
  unknown: Json[];
  /** spawn 时读到的 `-e` 扩展源码。 */
  extensionSource: string | undefined;
  extensionPath: string | undefined;
}

export interface FakePi {
  spawn: SpawnTransport;
  probe: ProgramProbe;
  instances: FakePiInstance[];
  config: FakePiConfig;
  last(): FakePiInstance;
  /** 所有实例收到的命令名。 */
  commandNames(): string[];
}

const KNOWN = new Set([
  "get_state",
  "get_available_models",
  "get_available_thinking_levels",
  "get_session_stats",
  "get_messages",
  "set_model",
  "set_thinking_level",
  "prompt",
  "steer",
  "abort",
]);

export function fakePi(config: FakePiConfig = {}): FakePi {
  const instances: FakePiInstance[] = [];
  const version = "version" in config ? config.version : "1.5.0";
  const probe = new ProgramProbe({
    env: { PATH: "/fake" },
    isFile: () => config.missing !== true,
    runVersion: async () => (version === undefined ? "unreadable" : `${version}\n`),
  });
  const spawn: SpawnTransport = (spec) => {
    const eIndex = spec.args.indexOf("-e");
    const extensionPath = eIndex >= 0 ? spec.args[eIndex + 1] : undefined;
    let extensionSource: string | undefined;
    try {
      if (extensionPath !== undefined) extensionSource = readFileSync(extensionPath, "utf8");
    } catch {
      extensionSource = undefined;
    }
    const instance = {
      spec,
      commands: [],
      uiResponses: [],
      unknown: [],
    } as unknown as FakePiInstance;
    instance.extensionSource = extensionSource;
    instance.extensionPath = extensionPath;
    instance.mem = memoryTransport((input, output) => serve(config, spec, instance, input, output));
    instances.push(instance);
    return instance.mem.transport;
  };
  return {
    spawn,
    probe,
    instances,
    config,
    last: () => instances.at(-1)!,
    commandNames: () => instances.flatMap((i) => i.commands.map((c) => String(c["type"]))),
  };
}

function serve(
  config: FakePiConfig,
  spec: TransportSpec,
  instance: FakePiInstance,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<void> {
  const sessionIdArg = spec.args[spec.args.indexOf("--session-id") + 1] ?? "pi-session";
  const models = config.models ?? FAKE_MODELS;
  let model: Json | null = "model" in config ? (config.model ?? null) : (models[0] ?? null);
  let level = config.thinkingLevel ?? "medium";
  const levelsFor = (): string[] =>
    config.levels ?? (model?.["reasoning"] === true ? ["off", "low", "medium", "high"] : ["off"]);
  const messages = config.messages ?? [];
  const write = (record: Json): void => void output.write(`${JSON.stringify(record)}\n`);
  const answer = (cmd: Json, data?: Json, success = true, error?: string): void =>
    write({
      ...(cmd["id"] !== undefined ? { id: cmd["id"] } : {}),
      type: "response",
      command: cmd["type"],
      success,
      ...(data !== undefined ? { data } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  const uiWaiters = new Map<string, (r: Json) => void>();
  let uiCounter = 0;
  let running = false;
  let abortSeen!: () => void;
  let aborted = new Promise<void>((resolve) => (abortSeen = resolve));
  let settleNow: ((aborted: boolean) => void) | undefined;

  const turnFor = (cmd: Json): FakePiTurn => {
    const emit = (record: Json): void => write(record);
    const ui = (request: Json): Promise<Json> => {
      const id = `ui-${++uiCounter}`;
      write({ type: "extension_ui_request", id, ...request });
      const dialog = ["select", "confirm", "input", "editor"].includes(String(request["method"]));
      if (!dialog) return Promise.resolve({});
      return new Promise<Json>((resolve) => uiWaiters.set(id, resolve));
    };
    const turn: FakePiTurn = {
      message: String(cmd["message"] ?? ""),
      images: cmd["images"] as Json[] | undefined,
      emit,
      text: (delta) =>
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
        }),
      think: (delta) =>
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta },
        }),
      assistantEnd: (options = {}) =>
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: options.text ?? "" }],
            stopReason: options.stopReason ?? "stop",
            ...(options.errorMessage !== undefined ? { errorMessage: options.errorMessage } : {}),
            usage: options.usage ?? {
              input: 10,
              output: 5,
              cacheRead: 100,
              cacheWrite: 0,
              totalTokens: 115,
              cost: { total: 0.01 },
            },
          },
        }),
      tool: async (o) => {
        const parent = o.parent !== undefined ? { parentToolCallId: o.parent } : {};
        // 与 Pi 一致：先 tool_execution_start，再进 tool_call 钩子（审批闸），放行后才执行
        emit({
          type: "tool_execution_start",
          toolCallId: o.id,
          toolName: o.name,
          args: o.args ?? {},
          ...parent,
        });
        if (o.gate !== undefined) {
          const reply = await ui({
            method: "confirm",
            title: "ama-approval",
            message: JSON.stringify({ id: o.id, tool: o.name, input: o.args ?? {}, ...o.gate }),
          });
          if (reply["confirmed"] !== true) {
            emit({
              type: "tool_execution_end",
              toolCallId: o.id,
              toolName: o.name,
              result: {
                content: [{ type: "text", text: `${o.name} was not approved by the user` }],
              },
              isError: true,
              ...parent,
            });
            return false;
          }
        }
        for (const partial of o.partials ?? [])
          emit({
            type: "tool_execution_update",
            toolCallId: o.id,
            toolName: o.name,
            args: o.args ?? {},
            partialResult: partial,
            ...parent,
          });
        emit({
          type: "tool_execution_end",
          toolCallId: o.id,
          toolName: o.name,
          result: o.result ?? { content: [{ type: "text", text: "ok" }] },
          isError: o.isError === true,
          ...parent,
        });
        return true;
      },
      ui,
      get aborted() {
        return aborted;
      },
      settle: (wasAborted = false) => settleNow?.(wasAborted),
    };
    return turn;
  };

  return new Promise<void>((resolve) => {
    createLineReader(
      input,
      (line) => {
        const cmd = JSON.parse(line) as Json;
        if (cmd["type"] === "extension_ui_response") {
          instance.uiResponses.push(cmd);
          uiWaiters.get(String(cmd["id"]))?.(cmd);
          uiWaiters.delete(String(cmd["id"]));
          return;
        }
        instance.commands.push(cmd);
        const type = String(cmd["type"]);
        if (config.hangOn === type) return;
        if (!KNOWN.has(type)) {
          instance.unknown.push(cmd);
          // 旧版 Pi：未知命令的应答不带 id
          write({ type: "response", command: "parse", success: false, error: `unknown ${type}` });
          return;
        }
        switch (type) {
          case "get_state":
            answer(cmd, {
              ...(model !== null ? { model } : {}),
              thinkingLevel: level,
              isStreaming: running,
              sessionId: sessionIdArg,
              messageCount: messages.length,
            });
            return;
          case "get_available_models":
            answer(cmd, { models });
            return;
          case "get_available_thinking_levels":
            answer(cmd, { levels: levelsFor() });
            return;
          case "get_session_stats":
            answer(
              cmd,
              config.stats?.() ?? {
                cost: 0.42,
                contextUsage: {
                  tokens: 1234,
                  contextWindow: Number(model?.["contextWindow"] ?? 0),
                },
              },
            );
            return;
          case "get_messages":
            answer(cmd, { messages });
            return;
          case "set_model": {
            const next = models.find(
              (m) => m["provider"] === cmd["provider"] && m["id"] === cmd["modelId"],
            );
            if (next === undefined) {
              answer(cmd, undefined, false, "Model not found");
              return;
            }
            model = next;
            if (!levelsFor().includes(level)) level = levelsFor().at(-1) ?? "off";
            answer(cmd, next);
            return;
          }
          case "set_thinking_level":
            level = String(cmd["level"]);
            answer(cmd);
            return;
          case "abort":
            answer(cmd);
            abortSeen();
            if (running && config.ignoreAbort !== true) settleNow?.(true);
            return;
          case "prompt": {
            answer(cmd, { disposition: config.disposition ?? "started" });
            if ((config.disposition ?? "started") === "handled") return;
            running = true;
            aborted = new Promise<void>((r) => (abortSeen = r));
            write({ type: "agent_start" });
            let done = false;
            settleNow = (wasAborted) => {
              if (done) return;
              done = true;
              running = false;
              write({ type: "agent_end", messages: [], willRetry: false });
              write({ type: "agent_settled", aborted: wasAborted });
            };
            void (config.onPrompt ?? (async (t) => t.assistantEnd({ text: "ok" })))(turnFor(cmd))
              .then(() => settleNow?.(false))
              .catch(() => settleNow?.(false));
            return;
          }
          default:
            answer(cmd);
        }
      },
      () => {
        output.end();
        resolve();
      },
    );
  });
}

export type { WireLine };
