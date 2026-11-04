/**
 * `ama --mode acp --bridge pi` 的 ACP 服务端（#254）：把 Pi 的 RPC 会话暴露为 ACP Agent。
 *
 * - `initialize`：`loadSession`、`sessionCapabilities {resume, close}`（不报 `list`：Pi 的 RPC 没有列会话的命令，
 *   桥也不读 Pi 的会话目录）、`mcpCapabilities {http}`、`authMethods: []`（在 Pi 里用 `/login`）；
 * - `session/new|load|resume`：用 `--session-id` 起 `pi --mode rpc`，ACP sessionId 就是 Pi 的会话 id；load / resume
 *   的会话在 Pi 里没有消息就当不存在（Pi 会静默新建），答 -32002 并收掉进程；load 回放历史，resume 不回放；
 * - Pi 低于下限答 `pi_outdated`、找不到答 `pi_missing`（`error.data.code`）；高于已验证区间或读不出版本照跑，
 *   stderr 一行，答复 `_meta["armadra.pi"] = { version, verified: false }`；
 * - 四个权限模式（`modes`，`session/set_mode` 立即生效）由审批闸实现；客户端的 `mcpServers` 写进 `bridge.json`
 *   交给 Pi 内置的 MCP；`session/request_permission` 只发给客户端，桥从不代答。
 */

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { AMA_VERSION } from "../../version.js";
import type { DriverDeps } from "../../drivers/base.js";
import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  RPC_ERRORS,
  type AcpAgentCapabilities,
  type AcpInitializeResult,
  type AcpSessionConfigOption,
  type AcpSessionUpdate,
} from "../../drivers/acp/types.js";
import { RpcError, type IncomingRequestContext } from "../../drivers/jsonrpc.js";
import { PI_CONFIG_ENV, writePiExtension } from "../../drivers/native/pi-extension.js";
import { ProgramProbe } from "../../drivers/probe.js";
import { spawnTransport, type SpawnTransport } from "../../drivers/process.js";
import { msg } from "../../i18n/index.js";
import { clientCapabilitiesOf, type AcpConnection } from "../../modes/acp/acp-connection.js";
import {
  PI_FLOOR,
  PI_PACKAGE,
  PI_VERIFIED,
  piVersionInfo,
  type PiVersionInfo,
} from "./capabilities.js";
import { piMcpPlan } from "./mcp.js";
import { PiBridgeSession } from "./session.js";

export const BRIDGE_AGENT_CAPABILITIES: AcpAgentCapabilities = {
  loadSession: true,
  promptCapabilities: { image: true, audio: false, embeddedContext: true },
  mcpCapabilities: { http: true, sse: false },
  sessionCapabilities: { resume: {}, close: {} },
};

/** 测试与宿主可注入的依赖。 */
export interface BridgeDeps extends Pick<DriverDeps, "cancelGraceMs" | "setTimer"> {
  /** 开会话时最多等扩展的能力报告多久（毫秒，缺省 300）。 */
  statusWaitMs?: number;
  /** 缺省起真实子进程。 */
  spawn?: SpawnTransport;
  /** 缺省按 PATH 找 `pi` 并跑 `pi --version`。 */
  probe?: ProgramProbe;
}

export interface BridgeServerOptions {
  connection: AcpConnection;
  /** `--` 之后交给 pi 的参数。 */
  passthrough: readonly string[];
  env: NodeJS.ProcessEnv;
  log(message: string): void;
  deps?: BridgeDeps;
}

export type Params = Record<string, unknown>;

interface PiLaunch {
  path: string;
  info: PiVersionInfo;
}

type OpenKind = "new" | "load" | "resume";

function str(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "")
    throw new RpcError(RPC_ERRORS.invalidParams, msg().bridge.session.missingParam(key));
  return value;
}

export class PiBridgeServer {
  private readonly peer;
  private readonly pool = new Map<string, PiBridgeSession>();
  private launching: Promise<PiLaunch> | undefined;

  constructor(private readonly options: BridgeServerOptions) {
    this.peer = options.connection.peer;
  }

  get sessions(): ReadonlyMap<string, PiBridgeSession> {
    return this.pool;
  }

  handleNotification(method: string, params: unknown): void {
    if (method === ACP_METHODS.sessionCancel) {
      const id = (params as Params | null)?.["sessionId"];
      if (typeof id === "string") this.pool.get(id)?.cancel();
    }
  }

  async handle(method: string, params: Params, ctx?: IncomingRequestContext): Promise<unknown> {
    switch (method) {
      case ACP_METHODS.initialize:
        return this.initialize(params);
      case ACP_METHODS.sessionNew:
        return this.open("new", params, ctx);
      case ACP_METHODS.sessionLoad:
        return this.open("load", params, ctx);
      case ACP_METHODS.sessionResume:
        return this.open("resume", params, ctx);
      case ACP_METHODS.sessionClose:
        return this.close(params);
      case ACP_METHODS.sessionPrompt:
        return this.prompt(params, ctx);
      case ACP_METHODS.sessionSetMode:
        this.session(params).setMode(str(params, "modeId"));
        return {};
      case ACP_METHODS.sessionSetConfigOption:
        return this.setConfigOption(params);
      default:
        throw new RpcError(RPC_ERRORS.methodNotFound, `method not found: ${method}`);
    }
  }

  private initialize(params: Params): AcpInitializeResult {
    if (typeof params["protocolVersion"] !== "number")
      throw new RpcError(
        RPC_ERRORS.invalidParams,
        msg().bridge.session.missingParam("protocolVersion"),
      );
    this.options.connection.markInitialized(clientCapabilitiesOf(params));
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: BRIDGE_AGENT_CAPABILITIES,
      authMethods: [],
      agentInfo: { name: "ama", title: "ama (Pi bridge)", version: AMA_VERSION },
    };
  }

  private session(params: Params): PiBridgeSession {
    const id = str(params, "sessionId");
    const session = this.pool.get(id);
    if (session === undefined)
      throw new RpcError(RPC_ERRORS.resourceNotFound, msg().bridge.session.notOpen(id));
    return session;
  }

  /** 找 `pi` 并读版本；整个进程只做一次。 */
  private launch(): Promise<PiLaunch> {
    this.launching ??= this.locate();
    return this.launching;
  }

  private async locate(): Promise<PiLaunch> {
    const m = msg().bridge.pi;
    const probe = this.options.deps?.probe ?? new ProgramProbe({ env: this.options.env });
    const located = await probe.locate("pi");
    if (located === undefined)
      throw new RpcError(RPC_ERRORS.internalError, m.missing(PI_PACKAGE), {
        code: "pi_missing",
        package: PI_PACKAGE,
      });
    const info = piVersionInfo(located.version);
    if (info.status === "unsupported")
      throw new RpcError(
        RPC_ERRORS.internalError,
        m.outdated(located.version!, PI_FLOOR, PI_PACKAGE),
        {
          code: "pi_outdated",
          installed: located.version,
          minimum: PI_FLOOR,
          package: PI_PACKAGE,
        },
      );
    if (info.status === "newer") this.options.log(m.unverified(located.version!, PI_VERIFIED));
    if (info.status === "unknown") this.options.log(m.versionUnknown(PI_VERIFIED));
    return { path: located.path, info };
  }

  private async open(
    kind: OpenKind,
    params: Params,
    ctx: IncomingRequestContext | undefined,
  ): Promise<unknown> {
    const cwd = str(params, "cwd");
    if (!isAbsolute(cwd))
      throw new RpcError(RPC_ERRORS.invalidParams, msg().bridge.session.invalidCwd(cwd));
    const requested = kind === "new" ? randomUUID() : str(params, "sessionId");
    const launch = await this.launch();
    const existing = this.pool.get(requested);
    if (existing !== undefined) {
      if (kind === "load") await existing.replay();
      return this.opened(kind, existing, launch);
    }
    const env = { ...this.options.env };
    // 子进程是 pi，不是 ama
    delete env["AMA"];
    delete env["AI_AGENT"];
    // MCP 透传：客户端的 mcpServers 写进 bridge.json，扩展加载时交给 Pi 内置的 MCP（ama 自己不说 MCP）
    const mcp = piMcpPlan(params["mcpServers"]);
    if (mcp.skipped.length > 0)
      this.options.log(msg().bridge.pi.mcpSkipped(mcp.skipped.join(", ")));
    const gate = writePiExtension({ mcpServers: mcp.servers });
    if (gate.configPath !== undefined) env[PI_CONFIG_ENV] = gate.configPath;
    const transport = (this.options.deps?.spawn ?? ((spec) => spawnTransport(spec)))({
      program: launch.path,
      args: [
        "--mode",
        "rpc",
        "--session-id",
        requested,
        "-e",
        gate.path,
        ...this.options.passthrough,
      ],
      cwd,
      env,
    });
    let session!: PiBridgeSession;
    session = new PiBridgeSession({
      id: requested,
      cwd,
      transport,
      info: launch.info,
      emit: (update: AcpSessionUpdate) =>
        void this.peer.notify(ACP_METHODS.sessionUpdate, { sessionId: session.sessionId, update }),
      log: this.options.log,
      mcpServers: mcp.names,
      askPermission: (request, signal) =>
        this.peer.request(ACP_METHODS.requestPermission, request, signal),
      ...(this.options.deps !== undefined ? { deps: this.options.deps } : {}),
      dispose: () => gate.dispose(),
    });
    try {
      await session.start(ctx?.signal);
      if (kind !== "new" && session.existingMessages === 0)
        throw new RpcError(RPC_ERRORS.resourceNotFound, msg().bridge.session.notFound(requested));
      this.pool.set(session.sessionId, session);
      if (kind === "load") await session.replay();
    } catch (error) {
      await session.close();
      throw error;
    }
    return this.opened(kind, session, launch);
  }

  /** new / load / resume 的答复；答复发出后再公布用量。 */
  private opened(
    kind: OpenKind,
    session: PiBridgeSession,
    launch: PiLaunch,
  ): Record<string, unknown> {
    setImmediate(() => void session.reportUsage());
    const configOptions = session.configOptions();
    const capabilities = session.capabilities();
    return {
      ...(kind === "new" ? { sessionId: session.sessionId } : {}),
      modes: session.modes(),
      ...(configOptions.length > 0 ? { configOptions } : {}),
      _meta: {
        "armadra.pi": {
          ...(launch.info.version !== undefined ? { version: launch.info.version } : {}),
          verified: launch.info.status === "verified",
          ...(capabilities !== undefined ? { capabilities } : {}),
        },
      },
    };
  }

  private async prompt(params: Params, ctx: IncomingRequestContext | undefined) {
    const session = this.session(params);
    const onAbort = (): void => session.cancel();
    ctx?.signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await session.prompt(params["prompt"]);
    } finally {
      ctx?.signal.removeEventListener("abort", onAbort);
    }
  }

  private async setConfigOption(
    params: Params,
  ): Promise<{ configOptions: AcpSessionConfigOption[] }> {
    const session = this.session(params);
    const value = params["value"];
    if (typeof value !== "string")
      throw new RpcError(RPC_ERRORS.invalidParams, msg().bridge.session.missingParam("value"));
    return { configOptions: await session.setConfigOption(str(params, "configId"), value) };
  }

  private async close(params: Params): Promise<Record<string, never>> {
    const session = this.session(params);
    this.pool.delete(session.sessionId);
    await session.close();
    return {};
  }

  /** 连接结束：关掉全部会话。 */
  async dispose(): Promise<void> {
    const sessions = [...this.pool.values()];
    this.pool.clear();
    await Promise.allSettled(sessions.map((s) => s.close()));
  }
}
