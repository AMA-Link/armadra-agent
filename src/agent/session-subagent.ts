/**
 * 子 Agent（设计 §5.2 task、D14；第五波 docs/history/wave5-plan.md §7，D22–D24）：`ToolContext.spawnSubagent`
 * 的实现与 ama 自己的 runner（`AmaRunner`）。[B2 → W5-G]
 *
 * - `runSubagent`：交给会话的任务注册表（subagent-registry.ts）——类型解析、并发池、前台 / 后台、
 *   续聊、结果上限、事件都在那里；这里只提供「起一个 ama 子会话」的 runner。
 * - 子会话：同进程新会话，独立 JSONL（头的 parentSession 指回父文件；父为内存会话则子也在内存），
 *   首条 `custom{ama.task}` 记父 toolCallId 与 taskId；深度 ≤ 1（depth 1、无 spawnSubagent）。
 * - **工具表与父字节一致**（D23）：活动集 = 父活动集，`task` / `task_ctl` 保留在表里、运行时按深度
 *   拒绝，子会话首请求能命中父的 tools + system 前缀；角色说明进系统提示末位 `role` 节。只有类型
 *   声明了 `tools` / `disallowed-tools`（或调用参数给了 `tools`）时工具表才不同。
 * - 只读类型（`permission-mode: plan`）：子会话用一条 plan 模式的权限管线（规则同父），ask 一律转
 *   deny——写类工具与识别不了的 bash 被拒且不弹审批；`inherit` 共用父的管线（不会比父宽）。
 * - 轮数耗尽且最后停在工具结果上：以 `maxTurns: 1` 再跑一轮要最终报告（只靠提示、不发 `toolChoice`，
 *   [ME-A] D13 请求选项不变才能命中缓存；仍调用工具则结果回落为「没有文本」），状态 `max_turns`。
 * - [ME-A] `context: "fork"`（D1–D3，subagent-fork.ts）：子会话复制父分支到发起调用的 assistant 之前，
 *   不写 `role` 节、工具表与父相同、类型限制改由 `unavailableTools` 在执行层拒绝；任务以 `<task>` 消息
 *   追加在继承的历史之后。不满足条件时回落 fresh（记 info 日志），结果的 `context` 标实际模式。
 * - broker 包一层，请求带 `context{depth, parentToolCallId, taskId}`，审批事件转发到父会话；
 *   [RW-B] 父的检查点钩子（worktree 里运行时不记）；[W3-C1b] 子会话命中与重计费汇总进父。
 * - [W6-A] 句柄外露 `observe` / `entries`（子 Agent 视图跟随）与 `message`（视图里直接发的消息，
 *   `origin: "direct"`：运行中 followUp，空闲开新一轮）；一轮收尾时才入队、没赶上的 followUp 接着再跑一轮。
 * - [#269] `report` 工具总在子会话可用（`CHILD_ONLY_TOOLS`，白名单 / 黑名单与 fork 的 `unavailableTools`
 *   都不去掉）；每次 `report` 调用（含 codemode 内层）按运行折叠成槽，发 `report` 进度事件，运行结束放进
 *   `SubagentResult.report`（agents/report.ts）。
 */

import type { CheckpointHooks } from "../checkpoints/types.js";
import { AmaError } from "../errors.js";
import { PermissionPipeline } from "../permissions/pipeline.js";
import type {
  ApprovalBroker,
  ApprovalRequestContext,
  PermissionPipelineApi,
} from "../permissions/types.js";
import { SessionManager } from "../session/manager.js";
import type { AgentMessage } from "../session/types.js";
import type { MessageOrigin } from "../ai/types.js";
import type {
  RunnerHandle,
  SubagentReport,
  SubagentReportUpdate,
  SubagentRequest,
  SubagentResult,
  SubagentRunRequest,
  SubagentRunner,
} from "../tools/types.js";
import { REPORT_TOOL } from "../tools/report.js";
import { agentRole } from "../agents/builtin.js";
import { foldReport } from "../agents/report.js";
import { ZERO_USAGE } from "./loop.js";
import type { RequestRecord } from "../ai/cache/types.js";
import type { AgentSessionOptions } from "./session-core.js";
import { forkBrief, forkPlan, requestedContext, type ContextMode } from "./subagent-fork.js";
import {
  DEFAULT_SUBAGENT_CONCURRENCY,
  SubagentPool,
  TASK_CUSTOM_TYPE,
  type AmaRunnerSpec,
  type RegistryHost,
  type TaskHandle,
} from "./subagent-registry.js";
import { addCache, collect } from "./session-subagent-collect.js";
import { DEFAULT_MAX_DEPTH } from "./subagent-nest.js";
import { nestedSpawner, rootRegistryOf } from "./subagent-tree.js";
import { LIMIT_ERROR_PREFIX, formatUsd } from "./limits.js";
import type { SessionEvent, SessionStats } from "./types.js";

export { DEFAULT_SUBAGENT_CONCURRENCY, SubagentPool, TASK_CUSTOM_TYPE };
export const DEFAULT_SUBAGENT_MAX_TURNS = 30;
/** 子会话里保留在工具表、运行时拒绝的名字（深度 ≤ 1）。 */
export const PARENT_ONLY_TOOLS: readonly string[] = ["task", "task_ctl", "task_land"];
/** [#269] 子会话总是可用的工具（类型白名单 / 黑名单不能去掉；父会话里它运行时被拒）。 */
export const CHILD_ONLY_TOOLS: readonly string[] = [REPORT_TOOL];

/** [#317] 可再派任务的子会话的 role 节末尾说明。 */
export const NESTED_TASK_NOTE =
  "You may delegate parts of your task with task. Your sub-tasks run in the foreground, share " +
  "the session's concurrency limit and draw from your remaining turns and budget; do not " +
  "delegate trivial steps.";

export const FINAL_REPORT_PROMPT =
  "You have reached the turn limit for this task. Do not call any tools. Reply now with your " +
  "final report: what you did, key findings, and what is left unfinished.";

export interface SubagentParent extends RegistryHost {
  readonly options: AgentSessionOptions;
  readonly manager: SessionManager;
  readonly cwd: string;
  readonly depth: number;
  childBase(): Pick<AgentSessionOptions, "model" | "thinkingLevel" | "activeTools" | "system">;
  /** 子会话的审批事件转发给父会话的订阅者（RPC 客户端 / TUI 据此作答）。 */
  emit(event: SessionEvent): void;
  /** [RW-B] 父会话的检查点钩子：子会话的编辑记到父会话当前回合。 */
  checkpointHooks?(): CheckpointHooks | undefined;
  /** [W3-C1b] 父会话的缓存控制器：汇总子会话的命中与重计费。 */
  readonly cache?: {
    addSubagent(tokens: { cacheRead: number; prompt: number }, reBilledTokens: number): void;
    /** [ME-A] 父会话上一次真实请求（fork 的前提与上下文比例）。 */
    readonly lastTurn?: RequestRecord | undefined;
  };
}

/** 子会话的 broker：请求带上发起方上下文（对话框标 `[task:<agent>]`），其余原样交给父链。 */
export function brokersForChild(
  brokers: AgentSessionOptions["brokers"],
  context: ApprovalRequestContext,
): ApprovalBroker[] {
  return (brokers ?? []).map((broker) => ({
    // 请求已被内层子会话的 broker 标过任务（带 taskId）时保留内层，两层嵌套不被外层覆盖；
    // 会话自己填的 context（depth / readFiles，不带 taskId）仍由这一层标注
    ask: (request, signal) =>
      broker.ask(
        { ...request, context: request.context?.taskId === undefined ? context : request.context },
        signal,
      ),
  }));
}

export interface ChildSession {
  readonly manager: SessionManager;
  readonly messages: readonly AgentMessage[];
  prompt(text: string, options?: { origin?: MessageOrigin; interrupt?: boolean }): Promise<unknown>;
  /** [W6-A] 视图里直接发的消息（运行中排到回合结束）。 */
  followUp?(text: string, options?: { origin?: MessageOrigin }): Promise<unknown>;
  /** [W6-A] 取出排队消息（一轮收尾时才入队、没被消费的）。 */
  clearQueue?(): { steering: string[]; followUp: string[] };
  abort(): Promise<void>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  getStats(): SessionStats;
  getLastAssistantText(): string | null;
  dispose(): Promise<void>;
}

/**
 * 只读子会话的权限管线：plan 模式、规则同父；ask 一律转 deny（只读类型不弹审批）。
 * 父管线不是 `PermissionPipeline`（宿主 / SDK 自带实现）时退化为「只放行 read 类」。
 */
const readOnlyPipelines = new WeakSet<object>();

export function readOnlyPermission(
  parent: PermissionPipelineApi | undefined,
  cwd: string,
): PermissionPipelineApi {
  const base = parent instanceof PermissionPipeline ? parent : undefined;
  const inner = new PermissionPipeline({
    mode: "plan",
    rules: parent?.rules ?? [],
    cwd: base?.cwd ?? cwd,
    ...(parent?.projectRoot === undefined ? {} : { projectRoot: parent.projectRoot }),
    // 沿用父的 plan.bash（deny 更严时照样 deny；ask 由下面统一转 deny）
    ...(base === undefined ? {} : { planBash: base.planBash }),
  });
  const denied =
    "Read-only sub-agent: this call is not allowed (it would modify files or run a non-read-only command).";
  const pipeline: PermissionPipelineApi = {
    get mode() {
      return "plan" as const;
    },
    setMode: () => undefined,
    get rules() {
      return inner.rules;
    },
    check: (input) => {
      const verdict = inner.check(input);
      return verdict.decision === "ask"
        ? { ...verdict, decision: "deny", message: verdict.message ?? denied }
        : verdict;
    },
    rememberForSession: () => undefined,
    ...(parent?.projectRoot === undefined ? {} : { projectRoot: parent.projectRoot }),
  };
  readOnlyPipelines.add(pipeline);
  return pipeline;
}

/** 已经是只读管线的直接沿用（嵌套的只读子会话再派任务不套第二层）。 */
function readOnlyFrom(
  parent: PermissionPipelineApi | undefined,
  cwd: string,
): PermissionPipelineApi {
  return parent !== undefined && readOnlyPipelines.has(parent)
    ? parent
    : readOnlyPermission(parent, cwd);
}

function failed(text: string): SubagentResult {
  return { text, usage: { ...ZERO_USAGE }, stopReason: "error", isError: true, status: "failed" };
}

export async function runSubagent(
  parent: SubagentParent,
  request: SubagentRequest,
  _pool: SubagentPool,
  createChild: (options: AgentSessionOptions) => ChildSession,
): Promise<SubagentResult> {
  const nested = parent.options.nested;
  if (parent.depth > 0 && nested === undefined) return failed("subagents cannot spawn subagents");
  const registry = rootRegistryOf(parent);
  if (registry === undefined)
    return failed("Sub-agents are not available here (the main session has ended).");
  // parentTaskId 只由运行时写，task 工具从不设它
  const req = nested === undefined ? request : { ...request, parentTaskId: nested.taskId };
  const spawner = nested === undefined ? undefined : nestedSpawner(parent);
  return registry.run(req, (spec) => createAmaRunner(parent, spec, createChild), spawner);
}

/**
 * 活动集：缺省 = 父活动集（含 task / task_ctl，工具表对齐）；白名单 / 黑名单时按名过滤。
 * [#269] `report` 只要父注册了就总在（白名单 / 黑名单都不能去掉）。
 */
function childToolNames(
  parent: SubagentParent,
  spec: AmaRunnerSpec,
  base: readonly string[] | undefined,
  nestable = false,
): string[] {
  const available = new Set((parent.options.tools ?? []).map((tool) => tool.name));
  const all = [...(base ?? available)].filter((name) => available.has(name));
  // [#317] 可再派任务时显式列出的 task 保留；task_ctl / task_land 仍滤掉
  const keep = (name: string): boolean =>
    !PARENT_ONLY_TOOLS.includes(name) || (nestable && name === "task");
  const allow = spec.request.tools ?? spec.agent.tools;
  if (allow !== undefined) {
    return withChildOnly(
      allow.filter((name) => available.has(name) && keep(name)),
      available,
    );
  }
  const deny = spec.agent.disallowedTools;
  if (deny !== undefined) {
    return withChildOnly(
      all.filter((name) => !deny.includes(name) && keep(name)),
      available,
    );
  }
  return all;
}

/** [#269] 白名单 / 黑名单过滤之后补回子会话总是可用的工具（父注册了才补）。 */
function withChildOnly(names: string[], available: ReadonlySet<string>): string[] {
  for (const name of CHILD_ONLY_TOOLS)
    if (available.has(name) && !names.includes(name)) names.push(name);
  return names;
}

/** ama 自己的子会话 runner（同进程）。 */
export function createAmaRunner(
  parent: SubagentParent,
  spec: AmaRunnerSpec,
  createChild: (options: AgentSessionOptions) => ChildSession,
): SubagentRunner {
  return {
    id: "ama",
    start: (request) => startAmaChild(parent, spec, createChild, request),
  };
}

function childManager(parent: SubagentParent, spec: AmaRunnerSpec): SessionManager {
  if (spec.resumeFile !== undefined) return SessionManager.open(spec.resumeFile);
  const parentFile = parent.manager.file();
  const header = parentFile === undefined ? {} : { parentSession: parentFile };
  const dir = parent.manager.directory();
  const manager =
    dir === undefined
      ? SessionManager.inMemory(spec.cwd, header)
      : SessionManager.create(dir, spec.cwd, header);
  manager.append({
    type: "custom",
    customType: TASK_CUSTOM_TYPE,
    data: {
      taskId: spec.taskId,
      agent: spec.agent.name,
      parentToolCallId: spec.request.parentToolCallId,
      description: spec.request.description,
      parentSession: parentFile,
    },
  });
  // 立即落盘：subagent_start 带上子会话文件，续聊 / resume 靠它重开
  if (dir !== undefined) manager.flush();
  return manager;
}

async function startAmaChild(
  parent: SubagentParent,
  spec: AmaRunnerSpec,
  createChild: (options: AgentSessionOptions) => ChildSession,
  run: SubagentRunRequest,
): Promise<TaskHandle> {
  const base = parent.childBase();
  let model = base.model;
  if (spec.modelRef !== undefined) {
    const lookup = parent.options.providers.findModel(spec.modelRef);
    if (!lookup.ok) throw new AmaError("model_not_found", `unknown model ${spec.modelRef}`);
    model = lookup.model;
  }
  const thinkingLevel =
    spec.request.thinkingLevel ?? spec.agent.thinking ?? base.thinkingLevel ?? "off";
  const wanted =
    spec.resumeFile === undefined && requestedContext(spec.request, spec.agent) === "fork";
  // #149：比例来自 `subagents.forkMaxContextRatio`（注册表环境里的整段配置）
  const registry = rootRegistryOf(parent);
  const ratio = registry?.env.modelConfig?.subagents?.forkMaxContextRatio;
  const plan = wanted ? forkPlan(parent, spec, model, thinkingLevel, ratio) : undefined;
  if (plan !== undefined && "fallback" in plan)
    parent.log("info", `task ${spec.taskId}: fork falls back to fresh (${plan.fallback})`);
  const forked = plan !== undefined && "manager" in plan ? plan.manager : undefined;
  const mode: ContextMode | undefined = !wanted ? undefined : forked ? "fork" : "fresh";
  const manager = forked ?? childManager(parent, spec);
  const checkpointHooks = spec.isolated ? undefined : parent.checkpointHooks?.();
  /** 本次运行的上限（注册表按父余额截过；续聊时重新读）。 */
  const runLimits = (): { maxTurns: number; budgetUsd?: number } => {
    const run = registry?.runBudget(spec.taskId);
    return {
      maxTurns:
        run?.maxTurns ?? spec.request.maxTurns ?? spec.agent.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
      ...(run?.budgetUsd === undefined ? {} : { budgetUsd: run.budgetUsd }),
    };
  };
  let { maxTurns } = runLimits();
  const childDepth = parent.depth + 1;
  const maxDepth = registry?.env.maxDepth ?? DEFAULT_MAX_DEPTH;
  // 可派条件：fresh、深度未到顶、根会话还在；工具表里有 task 在下面判
  const nestable =
    forked === undefined &&
    parent.options.subagents !== false &&
    registry !== undefined &&
    childDepth < maxDepth;
  const allowed = childToolNames(parent, spec, base.activeTools, nestable);
  const nested =
    nestable && allowed.includes("task")
      ? {
          rootSessionId: parent.options.nested?.rootSessionId ?? parent.manager.id,
          taskId: spec.taskId,
          depth: childDepth,
          maxDepth,
        }
      : undefined;
  // fork：工具表 = 父活动集（前缀不变），类型限制的工具在执行层拒绝
  const inherited = base.activeTools ?? (parent.options.tools ?? []).map((tool) => tool.name);
  const unavailable = inherited.filter(
    (name) =>
      !allowed.includes(name) &&
      !PARENT_ONLY_TOOLS.includes(name) &&
      !CHILD_ONLY_TOOLS.includes(name),
  );
  // #150：<task> 里也列出按深度拒绝的 task / task_ctl（执行层的拒绝文案不变）
  const briefUnavailable = [
    ...unavailable,
    ...PARENT_ONLY_TOOLS.filter((name) => inherited.includes(name)),
  ];
  const options: AgentSessionOptions = {
    ...parent.options,
    ...base,
    // fork：系统提示与父相同（base.system，不加 role 节）
    ...(forked === undefined
      ? {
          system: {
            ...base.system,
            role:
              nested === undefined
                ? agentRole(spec.agent)
                : `${agentRole(spec.agent, { nested: true })}\n\n${NESTED_TASK_NOTE}`,
          },
        }
      : {}),
    sessionManager: manager,
    model,
    thinkingLevel,
    ...(forked === undefined ? { activeTools: allowed } : {}),
    brokers: brokersForChild(parent.options.brokers, {
      depth: parent.depth + 1,
      parentToolCallId: spec.request.parentToolCallId,
      taskId: spec.taskId,
    }),
    depth: childDepth,
    maxTurns,
    subagents: nested === undefined ? false : {},
  };
  // 继承自父 options 的字段要显式重置：嵌套范围、会话级上限（子会话只认本任务的美元预算）
  delete options.nested;
  delete options.limits;
  if (nested !== undefined) options.nested = nested;
  const budgetUsd = runLimits().budgetUsd;
  if (budgetUsd !== undefined) options.limits = { maxCostUsd: budgetUsd };
  if (forked !== undefined && unavailable.length > 0)
    options.unavailableTools = [...(parent.options.unavailableTools ?? []), ...unavailable];
  delete options.checkpointHooks;
  if (checkpointHooks !== undefined) options.checkpointHooks = checkpointHooks;
  // 只读：类型是 plan、请求要求只读，或嵌套任务的发起方是 plan（取更严者，权限不外溢）
  if (
    spec.agent.permissionMode === "plan" ||
    spec.request.readOnly === true ||
    (parent.options.nested !== undefined && parent.options.permission?.mode === "plan")
  )
    options.permission = readOnlyFrom(parent.options.permission, spec.cwd);
  const child = createChild(options);

  let turns = 0;
  let toolUse = false;
  /** [#317] 这次运行因美元预算停下（`limit_reached{cost}`）。 */
  const costLimit: { hit: { spent: number; limit: number } | undefined } = { hit: undefined };
  /** [#269] 这次运行的报告槽（runOnce 开始清空；codemode 内层调用的 report 同样折叠）。 */
  let report: SubagentReport | undefined;
  const unsubscribe = child.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.parentToolCallId === undefined)
      run.onEvent({ type: "tool", toolName: event.toolName, status: "started" });
    else if (
      event.type === "tool_execution_end" &&
      event.toolName === REPORT_TOOL &&
      !event.isError
    ) {
      const details = event.result.details as { report?: SubagentReportUpdate } | undefined;
      if (details?.report !== undefined) {
        report = foldReport(report, details.report);
        run.onEvent({ type: "report", report });
      }
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      run.onEvent({ type: "text", delta: event.assistantMessageEvent.delta });
    else if (event.type === "turn_end") {
      turns++;
      toolUse = event.toolResults.length > 0;
      const { input, output, cacheRead, cacheWrite, total } = child.getStats().tokens;
      const { cost } = child.getStats();
      run.onEvent({
        type: "usage",
        usage: { input, output, cacheRead, cacheWrite, totalTokens: total },
        ...(cost === undefined ? {} : { unit: "usd" as const, amount: cost }),
      });
      run.onEvent({ type: "turn", turn: turns });
    } else if (event.type === "limit_reached" && event.kind === "cost") {
      costLimit.hit = { spent: event.value, limit: event.limit };
    } else if (event.type === "permission_request" || event.type === "permission_resolved")
      parent.emit(event);
  });
  if (mode !== undefined) run.onEvent({ type: "context", mode });
  /**
   * [#278] 每次运行一个 controller：`stop()` 只中止当前这一次。`run.signal` 是首次启动那次运行的信号，
   * 续聊（句柄复用）时注册表换了新 controller 并经 `stop()` 传达，所以终态只看本次运行的信号，
   * 不再读已经陈旧的 `run.signal`（否则被停过一次的任务续聊后永远是 aborted）。
   */
  let runController: AbortController | undefined;
  let firstRun = true;
  const stopRun = (): Promise<void> => {
    runController?.abort();
    return child.abort();
  };
  const onAbort = (): void => void stopRun().catch(() => undefined);
  run.signal.addEventListener("abort", onAbort, { once: true });
  let billed = { cacheRead: 0, prompt: 0, reBilled: 0 };

  let active = false;
  /** 视图里「打断并发送」开的回合（runOnce 等它们跑完再收尾）。 */
  const forced: Promise<unknown>[] = [];
  const runOnce = async (prompt: string, origin?: MessageOrigin): Promise<SubagentResult> => {
    const startTurns = turns;
    let error: string | undefined;
    report = undefined;
    costLimit.hit = undefined;
    // 续聊按本次请求重算上限（limits 扩展每次运行开始重读 options.limits）
    const now = runLimits();
    maxTurns = now.maxTurns;
    options.maxTurns = maxTurns;
    if (now.budgetUsd === undefined) delete options.limits;
    else options.limits = { maxCostUsd: now.budgetUsd };
    active = true;
    const controller = new AbortController();
    runController = controller;
    const { signal } = controller;
    // 首次运行前请求信号就已中止：按 aborted 收尾；之后的运行不再看 run.signal
    if (firstRun && run.signal.aborted) controller.abort();
    firstRun = false;
    try {
      if (signal.aborted) throw new AmaError("aborted", "aborted");
      await child.prompt(prompt, origin === undefined ? {} : { origin });
      // [W6-A] 收尾阶段才入队的 followUp（只可能来自视图）留在队列里：接着再跑一轮
      for (;;) {
        while (forced.length > 0) await forced.shift();
        const left = child.clearQueue?.().followUp ?? [];
        if (left.length === 0 || signal.aborted) break;
        await child.prompt(left.join("\n\n"), { origin: "direct" });
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    active = false;
    const exhausted =
      error === undefined && !signal.aborted && turns - startTurns >= maxTurns && toolUse;
    if (exhausted) {
      options.maxTurns = 1;
      try {
        await child.prompt(FINAL_REPORT_PROMPT);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      } finally {
        options.maxTurns = maxTurns;
      }
    }
    const result = collect(child, error, exhausted, signal.aborted);
    const spentOut = (costLimit as typeof costLimit).hit as
      { spent: number; limit: number } | undefined;
    if (spentOut !== undefined && !signal.aborted) {
      // 预算耗尽是正常收尾：正文前一行说明，状态仍 completed
      const line = `[budget] stopped after spending ${formatUsd(spentOut.spent)} of the ${formatUsd(spentOut.limit)} budget`;
      result.text =
        `${line}\n${result.text.startsWith(LIMIT_ERROR_PREFIX) ? "" : result.text}`.trimEnd();
      result.stopReason = "limit_reached";
      result.isError = false;
      result.status = "completed";
    }
    if (mode !== undefined) result.context = mode;
    if (report !== undefined) result.report = report;
    billed = addCache(parent, child.getStats(), billed);
    const file = manager.file();
    if (file !== undefined) result.sessionFile = file;
    return result;
  };

  const first =
    forked === undefined
      ? run.prompt
      : forkBrief({
          prompt: run.prompt,
          role: spec.agent.prompt,
          unavailable: briefUnavailable,
          ...(spec.isolated ? { worktree: { cwd: spec.cwd, parentCwd: parent.cwd } } : {}),
        });
  let current = runOnce(first, spec.origin);
  const handle: TaskHandle = {
    id: manager.id,
    model: `${model.provider}/${model.id}`,
    ...(manager.file() === undefined ? {} : { sessionFile: manager.file() as string }),
    send: async (text) => {
      current = runOnce(text);
    },
    observe: (listener) => child.subscribe(listener),
    entries: () => child.manager.branch(),
    message: async (text, when) => {
      if (when === "send") {
        current = runOnce(text, "direct");
        return;
      }
      if (!active || child.followUp === undefined)
        throw new AmaError("task_idle", "the sub-agent is not running");
      if (when === "interrupt") {
        // 同步登记：被中止的那一轮一结束，runOnce 就接着等这一轮
        forced.push(child.prompt(text, { origin: "direct", interrupt: true }));
        return;
      }
      await child.followUp(text, { origin: "direct" });
    },
    wait: () => current,
    stop: stopRun,
    dispose: async () => {
      run.signal.removeEventListener("abort", onAbort);
      unsubscribe();
      await child.dispose();
    },
  };
  return handle satisfies RunnerHandle;
}
