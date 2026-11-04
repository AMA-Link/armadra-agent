/**
 * `ama --mode acp --bridge pi` 的进程入口（#254）。
 *
 * bootstrap 之前分流：不解析供应商与模型，不需要 ama 的 key 或会话；stdin / stdout 是 ACP（NDJSON），
 * 诊断写 stderr。退出语义同 `--mode acp`：stdin 关闭 → 收掉全部 Pi 子进程 → 退出 0；SIGINT / SIGTERM → 130 / 143。
 */

import { reportError } from "../../cli/bootstrap.js";
import type { CliIo } from "../../cli/deps.js";
import { ExitCode } from "../../cli/exit-codes.js";
import { createAcpConnection } from "../../modes/acp/acp-connection.js";
import { onTerminationSignals } from "../../modes/shared.js";
import { RpcError } from "../../drivers/jsonrpc.js";
import { RPC_ERRORS } from "../../drivers/acp/types.js";
import { parseBridgeArgs } from "./args.js";
import { PiBridgeServer, type BridgeDeps, type Params } from "./server.js";

export interface BridgeRunOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  deps?: BridgeDeps;
}

export async function runBridge(
  argv: readonly string[],
  io: Pick<CliIo, "stderr" | "env">,
  options: BridgeRunOptions = {},
): Promise<number> {
  let passthrough: string[];
  try {
    passthrough = parseBridgeArgs(argv).passthrough;
  } catch (error) {
    return reportError(error, io);
  }
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const log = (message: string): void => io.stderr(`ama: ${message}\n`);
  const target: { server?: PiBridgeServer } = {};
  const connection = createAcpConnection({ input: stdin, output: stdout }, log, {
    onRequest: async (method, params, ctx) => {
      if (target.server === undefined) throw new RpcError(RPC_ERRORS.internalError, method);
      return target.server.handle(method, (params ?? {}) as Params, ctx);
    },
    onNotification: (method, params) => target.server?.handleNotification(method, params),
  });
  const server = new PiBridgeServer({
    connection,
    passthrough,
    env: io.env as NodeJS.ProcessEnv,
    log,
    ...(options.deps !== undefined ? { deps: options.deps } : {}),
  });
  target.server = server;
  return new Promise<number>((resolve) => {
    let finished = false;
    const finish = async (code: number): Promise<void> => {
      if (finished) return;
      finished = true;
      offSignals();
      (stdin as { pause?: () => void }).pause?.();
      await server.dispose();
      await connection.peer.flush();
      connection.peer.close();
      resolve(code);
    };
    void connection.peer.closed.then(() => finish(ExitCode.Ok));
    const offSignals = onTerminationSignals((code) => void finish(code));
  });
}
