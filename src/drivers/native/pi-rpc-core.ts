/**
 * pi `--mode rpc` 的传输核心（驱动 `pi-rpc.ts` 与 ACP 桥 `bridge/pi` 共用，#254）。
 *
 * - 分帧：stdout 严格按 LF 切行（`createLineReader`），stdin 每条命令一行 JSON；
 * - 请求关联：每条命令带 `ama-<n>` 的 id，`response` 按 id 回到等待者；不带 id 的应答（旧版 Pi 对未知
 *   命令、坏 JSON 的应答）无从关联，直接忽略——所以这里**只发调用方列出的命令**（`commands`），
 *   并给每条非 prompt 命令一个 10 秒截止，到点以 `agent_timeout` 失败而不是永远等；
 * - 进程退出：所有挂起请求以 `agent_exited` 失败，并通知调用方一次；
 * - 事件与扩展 UI 请求原样交给调用方，核心不解释。
 */

import { AmaError } from "../../errors.js";
import { createLineReader } from "../../modes/rpc/jsonl.js";
import { stderrHint, type AgentTransport } from "../process.js";

export type Json = Record<string, unknown>;

/** 非 prompt 命令的截止。 */
export const PI_COMMAND_DEADLINE_MS = 10_000;

export interface PiRpcCoreOptions {
  transport: AgentTransport;
  /** 只允许发这些命令（缺省不限）；不在表里的命令不上线，直接 `agent_failed`。 */
  commands?: ReadonlySet<string>;
  /** `response`、`extension_ui_request` 以外的每条记录。 */
  onEvent(record: Json): void;
  /** `extension_ui_request`（对话框与 fire-and-forget 都在这里）。 */
  onUiRequest(record: Json): void;
  /** 进程退出（输出流结束），只调一次。 */
  onExit(error: AmaError): void;
  /** 一行不是 JSON。 */
  onNonJson?(): void;
  /** 退出错误的文案（缺省 `pi process exited[: <stderr 尾部>]`）。 */
  exitMessage?(hint: string): string;
  /** 截止错误的文案（缺省 `pi did not answer <command> in time`）。 */
  timeoutMessage?(command: string): string;
  deadlineMs?: number;
  setTimer?(fn: () => void, ms: number): () => void;
}

interface Pending {
  command: string;
  resolve(r: Json): void;
  reject(e: Error): void;
  clear(): void;
}

function defaultSetTimer(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export class PiRpcCore {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private isExited = false;

  constructor(private readonly options: PiRpcCoreOptions) {
    createLineReader(
      options.transport.stdout,
      (line) => this.onLine(line),
      () => this.onEnd(),
    );
    options.transport.stdin.on?.("error", () => undefined);
  }

  get exited(): boolean {
    return this.isExited;
  }

  exitError(): AmaError {
    const hint = stderrHint(this.options.transport);
    const text =
      this.options.exitMessage?.(hint) ?? `pi process exited${hint !== "" ? `: ${hint}` : ""}`;
    return new AmaError("agent_exited", text);
  }

  /** 发命令并等应答；`prompt` 不设截止（它的应答只表示「已接收」，但模型启动前的扩展钩子可能较慢）。 */
  request(command: Json): Promise<Json> {
    const name = String(command["type"] ?? "");
    if (this.isExited) return Promise.reject(this.exitError());
    const allowed = this.options.commands;
    if (allowed !== undefined && !allowed.has(name))
      return Promise.reject(new AmaError("agent_failed", `pi command not supported: ${name}`));
    const id = `ama-${this.nextId++}`;
    return new Promise<Json>((resolve, reject) => {
      const entry: Pending = { command: name, resolve, reject, clear: () => undefined };
      if (name !== "prompt") {
        const setTimer = this.options.setTimer ?? defaultSetTimer;
        entry.clear = setTimer(() => {
          if (this.pending.delete(id))
            reject(
              new AmaError(
                "agent_timeout",
                this.options.timeoutMessage?.(name) ?? `pi did not answer ${name} in time`,
              ),
            );
        }, this.options.deadlineMs ?? PI_COMMAND_DEADLINE_MS);
      }
      this.pending.set(id, entry);
      this.write({ id, ...command });
    });
  }

  /** 写一行（进程已退出则丢弃）。 */
  write(record: Json): void {
    if (this.isExited) return;
    this.options.transport.stdin.write(`${JSON.stringify(record)}\n`);
  }

  private onEnd(): void {
    if (this.isExited) return;
    this.isExited = true;
    const error = this.exitError();
    for (const p of this.pending.values()) {
      p.clear();
      p.reject(error);
    }
    this.pending.clear();
    this.options.onExit(error);
  }

  private onLine(line: string): void {
    let record: Json;
    try {
      record = JSON.parse(line) as Json;
    } catch {
      this.options.onNonJson?.();
      return;
    }
    switch (record["type"]) {
      case "response": {
        const id = record["id"];
        if (typeof id !== "string") return;
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        pending.clear();
        pending.resolve(record);
        return;
      }
      case "extension_ui_request":
        this.options.onUiRequest(record);
        return;
      default:
        this.options.onEvent(record);
    }
  }
}
