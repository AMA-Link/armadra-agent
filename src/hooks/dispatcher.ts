/**
 * HookDispatcher：实现 HookDispatcherApi（设计 §6.1、§6.3）。[B5]
 *
 * AgentSession（B2）在各钩子点调用 `run(event, payload, signal?, context?)`；公共字段（sessionId、
 * cwd、model、permissionMode、depth、host…）由构造时给的 `context()` 每次现取，再由第 4 参数
 * 按次覆盖（子 Agent 的 depth / sessionId / sessionFile）。每条 Hook 执行后回调
 * `onExecuted`（bootstrap 把它接到宿主事件 `hook_executed`）。matcher 只在 Pre/PostToolUse 生效。
 *
 * [#277] `read` 调用的 `toolInput.path` 先经组装根注入的 `normalizePath` 规范化（已注册的宿主资源引用 →
 * `小写scheme://path`，其它原文），matcher 与交给 Hook 脚本的 stdin 用同一个值——与权限规则看到的一致，
 * `DEMO://x` 绕不过 `read(demo://*)`。hooks 模块不 import tools，规范化函数由 bootstrap 提供。
 */

import type { LoadedHook } from "./config.js";
import { compileMatcher, type ToolMatcher } from "./matcher.js";
import { emptyOutcome, mergeResults } from "./protocol.js";
import { runHooks, type RunHookOptions } from "./runner.js";
import type {
  HookCommonContext,
  HookContextOverrides,
  HookDispatcherApi,
  HookEvent,
  HookEventPayload,
  HookInput,
  HookNotification,
  HookOutcome,
  HookRunResult,
  HookSource,
} from "./types.js";

export type { HookCommonContext } from "./types.js";

export type HookExecutor = (
  hooks: readonly LoadedHook[],
  input: HookInput,
  options: RunHookOptions,
) => Promise<HookRunResult[]>;

export interface HookDispatcherOptions {
  hooks: readonly LoadedHook[];
  context: () => HookCommonContext;
  /** 每条 Hook 结束后（含超时）回调；异常被吞掉。 */
  onExecuted?: (result: HookRunResult) => void;
  /** 合并后的 warning（Hook 失败、超时、冲突的 updatedInput）。 */
  onWarning?: (message: string) => void;
  /** 测试注入；缺省为子进程 runner。 */
  executor?: HookExecutor;
  /** 额外环境变量。 */
  env?: Readonly<Record<string, string | undefined>>;
  /** [#277] `read` 的 `path` 规范化（已注册资源引用 → 小写 scheme；其它原文）；缺省不改。 */
  normalizePath?: (path: string) => string;
}

/** 用 `overrides` 里值不为 undefined 的键覆盖 `base`。 */
function withOverrides(
  base: HookCommonContext,
  overrides: HookContextOverrides | undefined,
): HookCommonContext {
  if (overrides === undefined) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as HookCommonContext;
}

const TOOL_EVENTS: ReadonlySet<HookEvent> = new Set(["PreToolUse", "PostToolUse"]);

/** 只有内置 `read` 读宿主资源；write / edit 的 `scheme://x` 是普通文件名，保持原文。 */
const RESOURCE_TOOL = "read";

/**
 * [#277] Pre/PostToolUse 且工具为 `read`、`path` 为字符串时返回带规范化 `path` 的浅拷贝；其它情况原样返回。
 * 不改动调用方的输入对象。
 */
function normalizePayload(
  event: HookEvent,
  payload: HookEventPayload,
  normalize: ((path: string) => string) | undefined,
): HookEventPayload {
  if (normalize === undefined || !TOOL_EVENTS.has(event)) return payload;
  if (payload.toolName !== RESOURCE_TOOL) return payload;
  const input = payload.toolInput;
  if (typeof input !== "object" || input === null) return payload;
  const path = (input as Record<string, unknown>)["path"];
  if (typeof path !== "string") return payload;
  const normalized = normalize(path);
  if (normalized === path) return payload;
  return { ...payload, toolInput: { ...(input as Record<string, unknown>), path: normalized } };
}

interface CompiledHook {
  hook: LoadedHook;
  matcher: ToolMatcher;
  /** 只看工具名（has() 用）。 */
  nameMatcher: ToolMatcher;
}

export class HookDispatcher implements HookDispatcherApi {
  private readonly byEvent = new Map<HookEvent, CompiledHook[]>();
  private readonly options: HookDispatcherOptions;

  constructor(options: HookDispatcherOptions) {
    this.options = options;
    const sorted = [...options.hooks].sort((a, b) => a.order - b.order);
    for (const hook of sorted) {
      const list = this.byEvent.get(hook.event) ?? [];
      list.push({
        hook,
        matcher: compileMatcher(hook.matcher),
        nameMatcher: compileMatcher(hook.matcher, true),
      });
      this.byEvent.set(hook.event, list);
    }
  }

  private matching(event: HookEvent, toolName?: string, toolInput?: unknown): LoadedHook[] {
    const list = this.byEvent.get(event) ?? [];
    if (!TOOL_EVENTS.has(event)) return list.map((c) => c.hook);
    if (toolName === undefined) return list.map((c) => c.hook);
    return list.filter((c) => c.matcher(toolName, toolInput)).map((c) => c.hook);
  }

  has(event: HookEvent, toolName?: string): boolean {
    const list = this.byEvent.get(event) ?? [];
    if (list.length === 0) return false;
    if (!TOOL_EVENTS.has(event) || toolName === undefined) return true;
    // 不知道输入时只按工具名判断（括号参数视为可能匹配）。
    return list.some((c) => c.nameMatcher(toolName, undefined));
  }

  async run(
    event: HookEvent,
    rawPayload: HookEventPayload,
    signal?: AbortSignal,
    context?: HookContextOverrides,
  ): Promise<HookOutcome> {
    const payload = normalizePayload(event, rawPayload, this.options.normalizePath);
    const hooks = this.matching(event, payload.toolName, payload.toolInput);
    if (hooks.length === 0) return emptyOutcome();
    const common = withOverrides(this.options.context(), context);
    const input: HookInput = { ...common, ...payload, hookEventName: event };
    const executor = this.options.executor ?? runHooks;
    const runOptions: RunHookOptions = { cwd: common.cwd, signal };
    if (this.options.env !== undefined) runOptions.env = this.options.env;
    const results = await executor(hooks, input, runOptions);
    for (const result of results) {
      try {
        this.options.onExecuted?.(result);
      } catch {
        // 观察者异常不影响 Hook 结论
      }
    }
    const outcome = mergeResults(results);
    for (const warning of outcome.warnings) this.options.onWarning?.(warning);
    return outcome;
  }

  /** Notification 投递：纯通知，不等待结果、不抛错。 */
  notify(notification: HookNotification): void {
    if (!this.has("Notification")) return;
    void this.run("Notification", { notification }).catch(() => undefined);
  }

  list(): readonly { event: HookEvent; matcher?: string; command: string; source: HookSource }[] {
    const all: LoadedHook[] = [];
    for (const list of this.byEvent.values()) all.push(...list.map((c) => c.hook));
    return all
      .sort((a, b) => a.order - b.order)
      .map((hook) => {
        const item: { event: HookEvent; matcher?: string; command: string; source: HookSource } = {
          event: hook.event,
          command: hook.command,
          source: hook.source,
        };
        if (hook.matcher !== undefined) item.matcher = hook.matcher;
        return item;
      });
  }
}
