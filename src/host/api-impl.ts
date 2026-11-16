/**
 * HostApi 实现（设计 §6.2）。[B5]
 *
 * 核心不知道宿主：这里把 HostApi 的各个面接到注入的依赖上——工具注册表（B3）、会话访问器
 * （B2 组装后才可用，所以全部是惰性函数）、指令收集、broker 槽、sendUser、UI 通知。
 * 事件总线 `AgentEventBus` 由 bootstrap 创建并交给 AgentSession 发事件；处理器只观察，
 * 抛错记日志；`emit` 等待全部处理器（`session_shutdown` 需要被 await）。
 *
 * [W5-EG] `runners.provide`（docs/history/wave5-plan.md §5.5，D17）：宿主注入的 runner 进本适配器的
 * {@link HostRunnerRegistry}（跨会话共享），每个主会话的外部 Agent 入口（agents/external.ts）经
 * {@link hostRunnersOf} 取到它；有宿主时 ama 不自 spawn 外部 CLI，只认这里注入的。
 *
 * [#226] `runners.onDone` 与 `minor`（host-api 1.1）：每轮结束的事件由 registry 的观察包装发出，
 * 处理器异常走本适配器的 `log`。
 *
 * [#304] 每个 binding 记下自己的全部注册，`revoke()` 一次撤回（扩展 create 抛错 / 超时 / 未返回适配器时
 * 调用）；撤回后注册类方法一律忽略并记 warning（防住超时后迟到的注册）。
 *
 * [#306] runner 注册表放在 {@link HostContext}（宿主适配器与扩展共用，同 id 先到先得，`runner_exists`），
 * `onDone` 只回调本模块自己提供的 runner。
 *
 * [#270] `resources`（host-api 1.2）：注册进 bootstrap 注入的 {@link HostResourceRegistry}（read 工具
 * 持同一个实例）；未注入时本地新建一个（SDK / 测试），宿主激活后由 bootstrap 冻结。
 */

import {
  HostRunnerRegistry,
  type RunnerDoneHandler,
  type RunnerScope,
} from "../drivers/host-runners.js";
import { AmaError } from "../errors.js";
import { AMA_VERSION } from "../version.js";
import type {
  AgentEventName,
  AgentEvents,
  ApprovalBroker,
  HostAdapter,
  HostAdapterHandle,
  HostApi,
  HostCommand,
  HostMode,
  HostRunner,
  InstructionSource,
} from "./types.js";
import { HOST_API_MINOR, HOST_API_VERSION } from "./types.js";
import { HostCommandRegistry } from "./commands.js";
import { HostResourceRegistry } from "./resources.js";
import type { HostResource } from "../tools/resource-ref.js";
import type { ToolDefinition, ToolRegistryApi } from "../tools/types.js";
import type { WarmingDecisionHandler } from "../ai/cache/types.js";
import { msg } from "../i18n/index.js";

export type HostNotify = (message: string, level: "info" | "warn" | "error") => void;

export type HostLogLevel = "debug" | "info" | "warn" | "error";
export type HostLogger = (level: HostLogLevel, message: string, detail?: unknown) => void;

type Handler<E extends AgentEventName> = (event: AgentEvents[E]) => void | Promise<void>;

/** 进程内事件总线（宿主观察 AgentEvents）。 */
export class AgentEventBus {
  private readonly handlers = new Map<AgentEventName, Set<Handler<AgentEventName>>>();
  private readonly log: HostLogger;

  constructor(log: HostLogger = () => undefined) {
    this.log = log;
  }

  on<E extends AgentEventName>(name: E, handler: Handler<E>): () => void {
    const set = this.handlers.get(name) ?? new Set();
    set.add(handler as Handler<AgentEventName>);
    this.handlers.set(name, set);
    return () => {
      set.delete(handler as Handler<AgentEventName>);
    };
  }

  listenerCount(name: AgentEventName): number {
    return this.handlers.get(name)?.size ?? 0;
  }

  /** 依次调用处理器并等待；处理器异常记日志后继续。 */
  async emit<E extends AgentEventName>(name: E, event: AgentEvents[E]): Promise<void> {
    const set = this.handlers.get(name);
    if (set === undefined || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        await handler(event);
      } catch (error) {
        this.log("error", msg().drivers.host.handlerFailed(name), error);
      }
    }
  }
}

/** 惰性会话访问器（AgentSession 组装前调用返回占位值）。 */
export interface HostSessionAccess {
  id(): string;
  file(): string | undefined;
  cwd(): string;
  model(): { provider: string; id: string } | undefined;
}

export interface HostApiDeps {
  mode: HostMode;
  env?: Readonly<NodeJS.ProcessEnv>;
  session: HostSessionAccess;
  tools: ToolRegistryApi;
  bus: AgentEventBus;
  /** 运行中按 steer 入队；会话未组装时抛错。 */
  sendUser(text: string, origin: string): Promise<"started" | "queued">;
  /** 交互 / line 模式的 UI 通知；未提供时写 stderr。模式层也可晚绑定：`binding.setNotify()`。 */
  notify?: HostNotify;
  /** 状态变化回调（TUI 状态栏刷新）。 */
  onStatus?: (key: string, text: string | undefined) => void;
  log?: HostLogger;
  /** stderr 写入（测试注入）。 */
  stderr?: (text: string) => void;
  /** [#270] 宿主资源注册表（与 read 工具共用同一实例）；缺省新建。 */
  resources?: HostResourceRegistry;
}

/**
 * [#301] 多个模块（宿主适配器 + 本地扩展）共享的状态：工具注册表、事件总线、资源注册表经 deps 共享，
 * 其余——指令列表、broker 槽、保温处理器、通知函数、各模块的状态表——放在这里。
 * 单个宿主适配器时自己建一个，行为与此前一致。
 */
export interface HostContext {
  /** 全部模块追加的指令，按加载顺序（宿主适配器在前）。 */
  readonly instructions: InstructionSource[];
  /** broker 槽：第一个设置的模块占有，其余模块的 setBroker 被忽略。 */
  readonly broker: { owner?: symbol; value?: ApprovalBroker };
  /** 全部模块经 `cache.onWarmingDecision` 注册的处理器，按注册顺序；最后一个生效。 */
  readonly warming: WarmingDecisionHandler[];
  /** 各模块的状态表（merged 后给状态栏）。 */
  readonly statuses: Set<Map<string, string>>;
  /** 晚绑定的通知函数（所有模块共用）。 */
  notify: HostNotify | undefined;
  /** 全部模块经 `commands.register` 注册的斜杠命令。 */
  readonly commands: HostCommandRegistry;
  /** [#306] 全部模块经 `runners.provide` 注入的 runner（同 id 先到先得）。 */
  readonly runners: HostRunnerRegistry;
}

export interface HostContextOptions {
  notify?: HostNotify;
  /** 保留的命令名（内置命令、别名、交互界面命令）；由装配方注入。 */
  reservedCommand?: (name: string) => boolean;
}

export function createHostContext(options: HostContextOptions = {}): HostContext {
  return {
    instructions: [],
    broker: {},
    warming: [],
    statuses: new Set(),
    notify: options.notify,
    commands: new HostCommandRegistry(options.reservedCommand),
    runners: new HostRunnerRegistry(),
  };
}

/** 合并全部模块的状态（同键后加载者覆盖先加载者）。 */
export function mergedHostStatus(context: HostContext): ReadonlyMap<string, string> {
  const merged = new Map<string, string>();
  for (const map of context.statuses) for (const [k, v] of map) merged.set(k, v);
  return merged;
}

/** createHostApi 的产物：api 交给适配器，其余给 bootstrap / AgentSession。 */
export interface HostApiBinding {
  readonly api: HostApi;
  /** 共享上下文中全部模块追加的指令（系统提示 host 节，按加载与追加顺序）。 */
  readonly instructions: readonly InstructionSource[];
  /** 共享的 broker 槽（第一个设置的模块占有；占有者可再次设置）。 */
  broker(): ApprovalBroker | undefined;
  /** 适配器注册的工具名。 */
  readonly registeredTools: readonly string[];
  /** 适配器禁用的工具名。 */
  readonly disabledTools: readonly string[];
  status(): ReadonlyMap<string, string>;
  /** 绑定成 Runtime 持有的 handle。 */
  handle(adapter: HostAdapter, source: string): HostAdapterHandle;
  /**
   * 晚绑定 UI 通知（模式层在 TUI / RPC 就绪后调用）；覆盖构造时的 `deps.notify`，
   * 传 undefined 恢复为构造时的值（未提供则写 stderr）。
   */
  setNotify(fn?: HostNotify): void;
  /** [W3-C0] 宿主经 `cache.onWarmingDecision` 注册的否决钩子（最后注册且未注销的那个）。 */
  warmingDecider(): WarmingDecisionHandler | undefined;
  /** [#270] 宿主资源注册表（系统提示资源行与 read 工具都读它）。 */
  readonly resources: HostResourceRegistry;
  /** [#304] 撤回本 binding 的全部注册（幂等）；之后注册类调用被忽略并记 warning。 */
  revoke(): void;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;

const hostRunnerRegistries = new WeakMap<HostApi, HostRunnerRegistry>();

/** 共享的 runner 注册表（HostApi 不是本模块创建的返回 undefined；[#306] 全部模块共用同一张）。 */
export function hostRunnersOf(api: HostApi): HostRunnerRegistry | undefined {
  return hostRunnerRegistries.get(api);
}

function validateTool(tool: ToolDefinition): void {
  if (typeof tool !== "object" || tool === null) {
    throw new AmaError("invalid_arguments", msg().drivers.host.toolNotObject);
  }
  if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
    throw new AmaError("invalid_arguments", msg().drivers.host.toolBadName(String(tool.name)));
  }
  if (typeof tool.execute !== "function") {
    throw new AmaError("invalid_arguments", msg().drivers.host.toolNoExecute(tool.name));
  }
  if (!["read", "write", "execute"].includes(tool.permission)) {
    throw new AmaError("invalid_arguments", msg().drivers.host.toolBadPermission(tool.name));
  }
}

export function createHostApi(
  deps: HostApiDeps,
  context: HostContext = createHostContext({
    ...(deps.notify !== undefined ? { notify: deps.notify } : {}),
  }),
): HostApiBinding {
  const instructions = context.instructions;
  const token = Symbol("host-binding");
  const registeredTools: string[] = [];
  const disabledTools: string[] = [];
  const status = new Map<string, string>();
  context.statuses.add(status);
  const warmingHandlers = context.warming;
  const writeErr = deps.stderr ?? ((text: string) => void process.stderr.write(text));
  const log: HostLogger =
    deps.log ??
    ((level, message) => {
      if (level === "warn" || level === "error") writeErr(`ama: [host] ${message}\n`);
    });
  const runners = context.runners;
  const scope: RunnerScope = {
    owner: token,
    log: (message, error) => log("error", message, error),
  };
  const resources = deps.resources ?? new HostResourceRegistry();

  // [#304] 撤回材料：按注册顺序逆序执行；revoked 之后的注册类调用一律忽略
  const undo: (() => void)[] = [];
  let revoked = false;
  const ignored = (what: string): boolean => {
    if (revoked) log("warn", msg().drivers.host.revokedIgnored(what));
    return revoked;
  };
  const noop = (): void => undefined;
  const ownInstructions: InstructionSource[] = [];

  const api: HostApi = Object.freeze({
    version: HOST_API_VERSION,
    minor: HOST_API_MINOR,
    agent: Object.freeze({ name: "ama" as const, version: AMA_VERSION }),
    env: Object.freeze({ ...(deps.env ?? process.env) }),
    mode: deps.mode,
    session: Object.freeze({
      id: () => deps.session.id(),
      file: () => deps.session.file(),
      cwd: () => deps.session.cwd(),
      model: () => deps.session.model(),
    }),
    tools: Object.freeze({
      register(tool: ToolDefinition): void {
        if (ignored("tools.register")) return;
        validateTool(tool);
        if (deps.tools.get(tool.name) !== undefined) {
          throw new AmaError("tool_exists", msg().drivers.host.toolExists(tool.name));
        }
        deps.tools.register(tool, "host");
        registeredTools.push(tool.name);
        undo.push(() => deps.tools.unregister(tool.name));
      },
      disable(name: string): void {
        if (ignored("tools.disable")) return;
        if (!deps.tools.isDisabled(name)) {
          undo.push(() => deps.tools.enable(name));
        }
        deps.tools.disable(name);
        if (!disabledTools.includes(name)) disabledTools.push(name);
      },
      list: () => deps.tools.list(),
    }),
    instructions: Object.freeze({
      add(source: InstructionSource): void {
        if (ignored("instructions.add")) return;
        if (source.kind === "file" && typeof source.path !== "string") {
          throw new AmaError("invalid_arguments", msg().drivers.host.instructionNeedsPath);
        }
        if (source.kind === "text" && typeof source.text !== "string") {
          throw new AmaError("invalid_arguments", msg().drivers.host.instructionNeedsText);
        }
        const copy = { ...source };
        instructions.push(copy);
        ownInstructions.push(copy);
      },
    }),
    events: Object.freeze({
      on<E extends AgentEventName>(name: E, handler: Handler<E>): () => void {
        if (ignored("events.on")) return noop;
        const off = deps.bus.on(name, handler);
        undo.push(off);
        return off;
      },
    }),
    approvals: Object.freeze({
      setBroker(next: ApprovalBroker): void {
        if (ignored("approvals.setBroker")) return;
        if (typeof next?.ask !== "function") {
          throw new AmaError("invalid_arguments", msg().drivers.host.brokerNeedsAsk);
        }
        if (context.broker.owner !== undefined && context.broker.owner !== token) {
          log("warn", msg().drivers.host.brokerIgnored);
          return;
        }
        context.broker.owner = token;
        context.broker.value = next;
      },
    }),
    messages: Object.freeze({
      sendUser: (text: string, origin?: string) => deps.sendUser(text, origin ?? "host"),
    }),
    ui: Object.freeze({
      notify(message: string, level: "info" | "warn" | "error" = "info"): void {
        // 交互 / line 由 UI 显示；rpc 由模式转成事件；print（或未注入）写 stderr。
        if (context.notify !== undefined && deps.mode !== "print") {
          context.notify(message, level);
          return;
        }
        writeErr(`ama: [host${level === "info" ? "" : ` ${level}`}] ${message}\n`);
      },
      setStatus(key: string, text?: string): void {
        if (ignored("ui.setStatus")) return;
        if (text === undefined || text === "") status.delete(key);
        else status.set(key, text);
        deps.onStatus?.(key, text);
      },
    }),
    log,
    cache: Object.freeze({
      onWarmingDecision(handler: WarmingDecisionHandler): () => void {
        if (ignored("cache.onWarmingDecision")) return noop;
        if (typeof handler !== "function") {
          throw new AmaError("invalid_arguments", msg().drivers.host.warmingNeedsFunction);
        }
        warmingHandlers.push(handler);
        const off = (): void => {
          const index = warmingHandlers.lastIndexOf(handler);
          if (index >= 0) warmingHandlers.splice(index, 1);
        };
        undo.push(off);
        return off;
      },
    }),
    runners: Object.freeze({
      provide(runner: HostRunner): () => void {
        if (ignored("runners.provide")) return noop;
        const off = runners.provide(runner, token);
        undo.push(off);
        return off;
      },
      onDone(handler: RunnerDoneHandler): () => void {
        if (ignored("runners.onDone")) return noop;
        const off = runners.onDone(handler, scope);
        undo.push(off);
        return off;
      },
    }),
    commands: Object.freeze({
      register(command: HostCommand): () => void {
        if (ignored("commands.register")) return noop;
        const off = context.commands.register(command);
        undo.push(off);
        return off;
      },
      list: () => context.commands.list().map((c) => c.name),
    }),
    resources: Object.freeze({
      register(resource: HostResource): void {
        if (ignored("resources.register")) return;
        resources.register(resource);
        undo.push(() => resources.remove(resource.scheme, resource));
      },
      list: () => resources.schemes(),
    }),
  });
  hostRunnerRegistries.set(api, runners);

  const revoke = (): void => {
    if (revoked) return;
    revoked = true;
    for (const fn of undo.reverse()) {
      try {
        fn();
      } catch (error) {
        log("warn", String(error));
      }
    }
    undo.length = 0;
    for (const entry of ownInstructions) {
      const index = instructions.indexOf(entry);
      if (index >= 0) instructions.splice(index, 1);
    }
    registeredTools.length = 0;
    disabledTools.length = 0;
    if (context.broker.owner === token) {
      delete context.broker.owner;
      delete context.broker.value;
    }
    const keys = [...status.keys()];
    status.clear();
    context.statuses.delete(status);
    for (const key of keys) deps.onStatus?.(key, undefined);
  };

  return {
    api,
    instructions,
    broker: () => context.broker.value,
    registeredTools,
    disabledTools,
    status: () => status,
    handle(adapter: HostAdapter, source: string): HostAdapterHandle {
      return { adapter, api, source, status: () => status };
    },
    setNotify(fn?: HostNotify): void {
      context.notify = fn ?? deps.notify;
    },
    warmingDecider: () => warmingHandlers.at(-1),
    resources,
    revoke,
  };
}
