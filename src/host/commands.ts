/**
 * 斜杠命令注册表（#301，host-api 1.4 `commands.register`）。
 *
 * 宿主适配器与本地扩展共用一张表（HostContext 持有）；`commands-core` 在内置命令之后、提示模板之前
 * 查它。保留名（内置命令、别名、交互界面命令）由装配方经 `isReserved` 注入，host 层不依赖模式层。
 */

import { AmaError } from "../errors.js";
import { msg } from "../i18n/index.js";
import type { HostCommand, HostCommandContext, HostCommandResult } from "./types.js";

export const COMMAND_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** 只读视图（Runtime / 命令分派用）。 */
export interface HostCommandSource {
  get(name: string): HostCommand | undefined;
  list(): readonly HostCommand[];
}

export class HostCommandRegistry implements HostCommandSource {
  private readonly commands = new Map<string, HostCommand>();

  constructor(private readonly isReserved: (name: string) => boolean = () => false) {}

  register(command: HostCommand): () => void {
    const h = msg().drivers.host;
    if (typeof command !== "object" || command === null) {
      throw new AmaError("invalid_arguments", h.commandNotObject);
    }
    const name = command.name;
    if (typeof name !== "string" || !COMMAND_NAME.test(name)) {
      throw new AmaError("invalid_arguments", h.commandBadName(String(name)));
    }
    if (typeof command.description !== "string" || command.description.trim() === "") {
      throw new AmaError("invalid_arguments", h.commandNoDescription(name));
    }
    if (typeof command.run !== "function") {
      throw new AmaError("invalid_arguments", h.commandNoRun(name));
    }
    if (command.args !== undefined && typeof command.args !== "string") {
      throw new AmaError("invalid_arguments", h.commandBadArgs(name));
    }
    if (this.isReserved(name)) throw new AmaError("command_exists", h.commandReserved(name));
    if (this.commands.has(name)) throw new AmaError("command_exists", h.commandExists(name));
    const stored: HostCommand = {
      name,
      description: command.description,
      ...(command.args !== undefined ? { args: command.args } : {}),
      run: command.run,
    };
    this.commands.set(name, stored);
    return () => {
      if (this.commands.get(name) === stored) this.commands.delete(name);
    };
  }

  get(name: string): HostCommand | undefined {
    return this.commands.get(name);
  }

  list(): readonly HostCommand[] {
    return [...this.commands.values()];
  }
}

/** 调命令并校验结果形状；不合法抛 AmaError。命令自己抛的错原样上抛。 */
export async function runHostCommand(
  command: HostCommand,
  args: string,
  ctx: HostCommandContext,
): Promise<Exclude<HostCommandResult, undefined>> {
  const result = await command.run(args, ctx);
  if (result === undefined) return { kind: "handled" };
  const bad = (): AmaError =>
    new AmaError("invalid_result", msg().drivers.host.commandBadResult(command.name));
  if (typeof result !== "object" || result === null) throw bad();
  if (result.kind === "handled") {
    if (result.message !== undefined && typeof result.message !== "string") throw bad();
    return result.message === undefined
      ? { kind: "handled" }
      : { kind: "handled", message: result.message };
  }
  if (result.kind === "prompt" && typeof result.text === "string" && result.text !== "") {
    return { kind: "prompt", text: result.text };
  }
  throw bad();
}
