/**
 * 子 Agent 任务注册表（docs/history/wave5-plan.md §7.3–§7.6，D13、D23–D24）。[W5-G]
 *
 * 每个根会话一份（按会话 id 登记）。职责：解析类型（catalog）→ 选 runner（ama 子会话或外部 / 宿主
 * runner）；并发池（`subagents.maxConcurrent`，缺省 4）+ 排队上限；前台 / 后台；`taskId` 续聊；结果上限；
 * worktree 隔离；事件与父会话 `custom{ama.task}` 快照。[W6-A] 视图（subagent-direct.ts）；[W7-B1] 转后台与通知
 * （subagent-background.ts）；[#267] 后台寿命；[#269] 结构化报告；[#317] 嵌套派发（subagent-nest.ts：整棵树
 * 共享一个池与预算，记录收尾在 subagent-finish.ts）。
 */

import { AmaError } from "../errors.js";
import type {
  SubagentRequest,
  SubagentResult,
  SubagentRunner,
  TaskInfo,
  TaskRegistryView,
} from "../tools/types.js";
import { DEFAULT_AGENT } from "../agents/builtin.js";
import { AgentCatalog, type AgentModelConfig } from "../agents/catalog.js";
import {
  SubagentPool,
  TASK_CUSTOM_TYPE,
  failedResult as failed,
  beginRun,
  newRecord,
  rebuildRecords,
  taskStats,
  type AmaRunnerSpec,
  type ProgressSink,
  type TaskHandle,
  type NestedSpawner,
  type TaskLive,
  type TaskRecord,
  type TaskRunBudget,
} from "../agents/task-record.js";
import {
  registerTaskControl,
  unregisterTaskControl,
  type ExpiredTask,
  type TaskControl,
} from "../agents/task-control.js";
import type { ExtendOutcome } from "../tools/background-jobs.js";
import type { TimeoutTimers } from "../tools/timers.js";
import type { AgentDefinition, AgentInfo } from "../agents/types.js";
import type { SessionCore } from "./session-core.js";
import type { SessionTaskStats } from "./types.js";
import { prepareTaskWorktree } from "./worktree-setup.js";
import { landTask } from "./subagent-land.js";
import { appendTraceEntry } from "./session-trace-writer.js";
import { directMessage, drainDirect, liveOf, type DirectReply } from "./subagent-direct.js";
import {
  TaskNotifier,
  WaitDetach,
  backgroundRecords,
  blockingTasks,
  foregroundWaiter,
  settleTasks,
  startedResult,
  waitForTask,
  type BackgroundReason,
} from "./subagent-background.js";
import {
  DEFAULT_MAX_DEPTH,
  cascadeAbort,
  chargeAncestors,
  continueBlocked,
  ownSpent,
  parkParent,
  deriveRequest,
  planNested,
  rememberRequest,
  requestedLimits,
  reserveBudget,
  settleChild,
  unparkParent,
  type NestPlan,
  type RunLimits,
} from "./subagent-nest.js";
import { chooseTaskModel } from "./subagent-model.js";
import { finishRecord } from "./subagent-finish.js";
import { DEFAULT_RETAINED, SubagentStore } from "./subagent-store.js";
import { startHandle } from "./subagent-handle.js";
import {
  armLifetime,
  clearLifetime,
  extendLifetime,
  takeExpiredTasks,
  type LifetimeEnv,
} from "./subagent-lifetime.js";

export const DEFAULT_SUBAGENT_CONCURRENCY = 4;
export const DEFAULT_MAX_PENDING = 16;
export { DEFAULT_RETAINED };

export { SubagentPool, TASK_CUSTOM_TYPE, type AmaRunnerSpec, type TaskHandle };
export type { BackgroundReason };
export type AmaRunnerFactory = (spec: AmaRunnerSpec) => SubagentRunner;

export interface SubagentEnvironment {
  catalog: AgentCatalog;
  maxConcurrent?: number;
  maxPending?: number;
  retain?: number;
  modelConfig?: AgentModelConfig;
  /** [#317] 嵌套层数上限（`subagents.maxDepth`，缺省 2）。 */
  maxDepth?: number;
  /** 外部 / 宿主 runner（W5-E `ProcessRunner`、HostApi.runners）；没有返回 undefined。 */
  runners?(agent: AgentDefinition): SubagentRunner | undefined;
  now?(): number;
  /** [W7-B1] `task` 未指定 background 且类型也没指定时的缺省（`subagents.background` 解析后）；缺省前台。 */
  background?: boolean;
  /** [W7-B1] 前台任务运行超过该毫秒数自动转后台（`subagents.autoBackgroundAfterMs`）；0 / 不设关闭。 */
  autoBackgroundAfterMs?: number;
  /** [#267] 后台任务寿命上限（`subagents.backgroundMaxMs`，组装根给缺省 1 小时）；0 / 不设不限。 */
  backgroundMaxMs?: number;
  timers?: TimeoutTimers;
}

/** 注册表需要的父会话能力（`SessionCore`；followUp 为 AgentSessionImpl 的公开方法）。 */
export type RegistryHost = Pick<
  SessionCore,
  "manager" | "cwd" | "emit" | "appendEntry" | "outputDir" | "log" | "options"
> & {
  followUp?(text: string, options?: { origin?: string }): Promise<unknown>;
  waitForIdle?(): Promise<void>;
  /** [W6-A] 视图里续聊已结束的任务（AgentSessionImpl 的方法，经 runSubagent 拿到 ama runner 工厂）。 */
  spawnSubagent?(request: SubagentRequest): Promise<SubagentResult>;
};

const registries = new Map<string, SubagentRegistry>();

/** RPC `get_tasks` / `/tasks`：会话 id → 注册表视图（没有任务时 undefined）。 */
export function taskRegistryView(sessionId: string): TaskRegistryView | undefined {
  return registries.get(sessionId);
}

/** RPC `get_agents` / `/agents`：会话可用的类型（没有 task 工具、注册表未装配时为空）。 */
export function sessionAgents(sessionId: string): AgentInfo[] {
  return registries.get(sessionId)?.catalog.infos() ?? [];
}

export function registryOf(sessionId: string): SubagentRegistry | undefined {
  return registries.get(sessionId);
}

/** 取会话的注册表；没有就以 `env`（缺省只有内置类型）新建并登记。 */
export function subagentRegistryFor(
  host: RegistryHost,
  env: SubagentEnvironment = { catalog: new AgentCatalog() },
): SubagentRegistry {
  const existing = registries.get(host.manager.id);
  if (existing !== undefined) return existing;
  const registry = new SubagentRegistry(host, env);
  registries.set(host.manager.id, registry);
  registerTaskControl(host.manager.id, registry);
  return registry;
}

export class SubagentRegistry implements TaskControl {
  readonly catalog: AgentCatalog;
  private readonly pool: SubagentPool;
  private readonly tasks: Map<string, TaskRecord>;
  private readonly store: SubagentStore;
  private seq = 0;
  private disposed = false;
  private readonly notifier: TaskNotifier;
  private readonly waits = new WaitDetach();

  constructor(
    private readonly host: RegistryHost,
    readonly env: SubagentEnvironment,
  ) {
    this.catalog = env.catalog;
    this.pool = new SubagentPool(env.maxConcurrent ?? DEFAULT_SUBAGENT_CONCURRENCY);
    const rebuilt = rebuildRecords(host.manager.branch(), this.catalog, host.cwd);
    this.tasks = rebuilt.records;
    this.seq = rebuilt.seq;
    this.store = new SubagentStore(
      host,
      this.tasks,
      () => this.disposed,
      () => this.env.retain,
    );
    this.notifier = new TaskNotifier(host, () => this.disposed);
  }

  private now(): number {
    return this.env.now?.() ?? Date.now();
  }

  private lifetimeEnv(): LifetimeEnv {
    const env: LifetimeEnv = { now: () => this.now() };
    if (this.env.backgroundMaxMs !== undefined) env.backgroundMaxMs = this.env.backgroundMaxMs;
    if (this.env.timers !== undefined) env.timers = this.env.timers;
    return env;
  }

  /** [#267] 后台任务起寿命计时（从此刻起算）；到点按 stop 处理。 */
  private armLifetime(record: TaskRecord): void {
    armLifetime(record, this.lifetimeEnv(), () => record.controller?.abort());
  }

  /** [#267] 续命一次（task_ctl extend）。 */
  extend(taskId: string, ms?: number): ExtendOutcome {
    const record = this.tasks.get(taskId);
    return extendLifetime(record, this.lifetimeEnv(), () => record?.controller?.abort(), ms);
  }

  /** [#267] 到点被停止、尚未经提醒通道通知的任务。 */
  land(taskId: string) {
    return landTask(this.tasks.get(taskId), (record) => this.store.persist(record));
  }

  takeExpired(): ExpiredTask[] {
    return takeExpiredTasks(this.tasks.values());
  }

  // -------------------------------------------------------------------------
  // 视图
  // -------------------------------------------------------------------------

  list(): readonly TaskInfo[] {
    return [...this.tasks.values()].map((record) => ({ ...record.info }));
  }

  get(taskId: string): TaskInfo | undefined {
    const record = this.tasks.get(taskId);
    return record === undefined ? undefined : { ...record.info };
  }

  stats(): SessionTaskStats | undefined {
    return taskStats(this.tasks.values());
  }

  /** 运行中任务的已有输出（`task_ctl output`）；结束后为最终文本。 */
  output(taskId: string): string | undefined {
    return this.tasks.get(taskId)?.text;
  }

  /** 等结束；超时或 signal（缺省本任务的转后台信号，`background()` 触发）返回 undefined。[W7-B1] */
  async wait(
    taskId: string,
    timeoutMs: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<SubagentResult | undefined> {
    const record = this.tasks.get(taskId);
    if (record === undefined) throw new AmaError("task_not_found", `unknown task ${taskId}`);
    return waitForTask(record, timeoutMs, options.signal ?? this.waits.signal(taskId), this.waits);
  }

  detachSignal(taskId: string): AbortSignal {
    return this.waits.signal(taskId);
  }

  /** [W7-B1] 正在阻塞父回合的任务：运行中的前台任务与有 `task_ctl wait` 在等的任务。 */
  blocking(): string[] {
    return blockingTasks(this.tasks.values(), this.waits);
  }

  /**
   * [W7-B1] 前台任务转后台（§2.5，subagent-background.ts），并打断等它的 `task_ctl wait`；不给 taskId =
   * 全部。返回被转后台或被打断等待的 taskId（不在运行时为空）。
   */
  background(taskId?: string, reason: BackgroundReason = "user"): string[] {
    if (this.disposed) return [];
    const one = taskId === undefined ? undefined : this.tasks.get(taskId);
    const records =
      taskId === undefined ? [...this.tasks.values()] : one === undefined ? [] : [one];
    const moved = backgroundRecords(records, reason, {
      emit: (event) => this.host.emit(event),
      persist: (record) => this.store.persist(record),
      notify: (record, result) => this.notifier.notify(record, result),
      afterMs: this.env.autoBackgroundAfterMs ?? 0,
      outputFile: (id) => this.store.outputFileFor(id),
    });
    // [#267] 转后台的任务从转换时刻起算寿命
    for (const id of moved) {
      const record = this.tasks.get(id);
      if (record !== undefined) this.armLifetime(record);
    }
    return [...new Set([...moved, ...this.waits.detach(taskId)])];
  }

  /** [W7-B1] `-p` 收尾：等到没有运行中的任务、通知回合也已跑完；会话关闭立即返回。 */
  settled(): Promise<void> {
    return settleTasks(this.tasks, this.notifier, () => this.disposed);
  }

  /** [W6-A] 子 Agent 视图读的实时数据；未知任务 undefined。 */
  live(taskId: string): TaskLive | undefined {
    const record = this.tasks.get(taskId);
    return record === undefined ? undefined : liveOf(record);
  }

  /** [W6-A] 人在子 Agent 视图里发的消息（subagent-direct.ts）。 */
  async message(taskId: string, text: string, interrupt = false): Promise<DirectReply> {
    const record = this.tasks.get(taskId);
    if (record === undefined) throw new AmaError("task_not_found", `unknown task ${taskId}`);
    return directMessage(record, text, this.host, interrupt);
  }

  async stop(taskId: string): Promise<SubagentResult | undefined> {
    const record = this.tasks.get(taskId);
    if (record === undefined) throw new AmaError("task_not_found", `unknown task ${taskId}`);
    if (record.running === undefined) return record.last;
    record.controller?.abort();
    cascadeAbort(this.tasks, taskId); // [#317] 父 stop 级联到在跑的后代
    return record.running;
  }

  /** [#317] 子会话读本次运行的轮数 / 美元上限（续聊时按本次请求重算）。 */
  runBudget(taskId: string): Readonly<TaskRunBudget> | undefined {
    return this.tasks.get(taskId)?.run;
  }

  // -------------------------------------------------------------------------
  // 运行
  // -------------------------------------------------------------------------

  /** `spawner` 只由嵌套派发（发起子会话）给；此时 `request.parentTaskId` 是发起任务的 id。 */
  async run(
    request: SubagentRequest,
    ama: AmaRunnerFactory,
    spawner?: NestedSpawner,
  ): Promise<SubagentResult> {
    if (this.disposed) return failed("the session is closed");
    if (spawner === undefined && request.parentTaskId !== undefined) {
      request = { ...request };
      delete request.parentTaskId; // 只由运行时写
    }
    if (request.taskId !== undefined) return this.continueTask(request, ama, spawner);
    const name = request.agent ?? DEFAULT_AGENT;
    let agent = this.catalog.get(name);
    if (agent === undefined)
      return failed(`Unknown agent "${name}". Available: ${this.catalog.names().join(", ")}.`);
    if (agent.runner !== "ama" && this.env.runners?.(agent) === undefined)
      return failed(`External agent "${name}" (${agent.runner}) is not available here.`);
    const queued = this.pool.waiting;
    if (queued >= (this.env.maxPending ?? DEFAULT_MAX_PENDING))
      return failed(
        `Too many sub-agent tasks are queued (${queued}). Do not retry; wait for running tasks first (task_ctl wait).`,
      );
    const chosen = chooseTaskModel(
      { catalog: this.catalog, env: this.env, hostMode: this.host.options.permission?.mode },
      agent,
      request,
      spawner,
      (message) => this.host.log("warn", message),
    );
    const { model } = chosen;
    agent = chosen.agent;
    request = chosen.request;
    let limits: RunLimits = requestedLimits(undefined, request, agent.maxTurns);
    let parent: TaskRecord | undefined;
    if (spawner !== undefined) {
      const plan = this.plan(request, limits);
      if (typeof plan === "string") return failed(plan);
      ({ limits } = plan);
      parent = plan.parent;
    }
    const nested = parent !== undefined;
    // 嵌套与工作流任务一律前台
    const background =
      !nested &&
      request.workflow === undefined &&
      (request.background ?? agent.background ?? this.env.background ?? false);
    const taskId = `t${++this.seq}`;
    const record = newRecord(
      {
        taskId,
        agent: agent.name,
        runner: agent.runner,
        description: request.description ?? "",
        background,
        status: "running",
        startedAt: this.now(),
        ...(nested
          ? { parentTaskId: request.parentTaskId as string, depth: (parent?.info.depth ?? 1) + 1 }
          : {}),
        ...(request.workflow === undefined ? {} : { workflow: request.workflow }),
      },
      agent,
      request.parentToolCallId,
      parent?.cwd ?? this.host.cwd,
      request.isolation ?? agent.isolation,
      {
        firstPrompt: request.prompt,
        ...(spawner === undefined ? {} : { spawner }),
      },
    );
    rememberRequest(record, request);
    if (request.readOnly === true) record.readOnly = true; // 首跑记下，续聊沿用
    if (model.ref !== undefined) record.modelRef = model.ref;
    if (model.tier !== undefined) record.info.tier = model.tier;
    this.tasks.set(taskId, record);
    return this.launch(record, deriveRequest(request, limits), ama, background, limits, parent);
  }

  private plan(request: SubagentRequest, wanted: RunLimits): NestPlan | string {
    const { maxDepth = DEFAULT_MAX_DEPTH } = this.env;
    return planNested(this.tasks, request.parentTaskId ?? "", wanted, maxDepth);
  }

  private continueTask(
    request: SubagentRequest,
    ama: AmaRunnerFactory,
    spawner?: NestedSpawner,
  ): Promise<SubagentResult> {
    const record = this.tasks.get(request.taskId as string);
    const blocked = continueBlocked(record, request);
    if (blocked !== undefined || record === undefined)
      return Promise.resolve(failed(blocked ?? "unknown task"));
    let limits = requestedLimits(record, request, record.agent.maxTurns);
    let parent: TaskRecord | undefined;
    if (spawner !== undefined) {
      const plan = this.plan(request, limits);
      if (typeof plan === "string") return Promise.resolve(failed(plan));
      ({ limits } = plan);
      parent = plan.parent;
      record.spawner = spawner;
    }
    const background =
      parent === undefined &&
      record.info.workflow === undefined &&
      (request.background ?? record.agent.background ?? this.env.background ?? false);
    return this.launch(record, deriveRequest(request, limits), ama, background, limits, parent);
  }

  private launch(
    record: TaskRecord,
    request: SubagentRequest,
    ama: AmaRunnerFactory,
    background: boolean,
    limits: RunLimits,
    parent?: TaskRecord,
  ): Promise<SubagentResult> {
    beginRun(record, limits); // [#317] 轮数 / 美元按本次运行算
    if (record.readOnly === true && request.readOnly !== true)
      request = { ...request, readOnly: true };
    const controller = new AbortController();
    record.controller = controller;
    record.info.status = "running";
    record.info.background = background;
    delete record.info.endedAt;
    delete record.info.report; // [#269] 报告槽按运行划定
    // [#267] 上次到点被停止的标记不带进这次续聊；还没报告的标 relaunched
    if (record.expired?.taken === true) delete record.expired;
    else if (record.expired !== undefined) record.expired.relaunched = true;
    record.text = "";
    if (background) delete record.onUpdate;
    else if (request.onUpdate !== undefined) record.onUpdate = request.onUpdate;
    const parentSignal = background ? undefined : request.signal;
    const onParentAbort = (): void => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    this.store.persist(record);
    let timer: NodeJS.Timeout | undefined;
    const reserved = parent === undefined ? 0 : reserveBudget(parent, limits);
    if (parent !== undefined) parkParent(parent, this.pool);
    const exec = this.execute(record, request, ama, controller.signal, parent?.cwd);
    const settled =
      parent === undefined
        ? exec
        : exec.finally(async () => {
            settleChild(parent, record, reserved);
            await unparkParent(parent, this.pool);
          });
    const running = settled.finally(() => {
      clearTimeout(timer);
      clearLifetime(record, this.lifetimeEnv());
      parentSignal?.removeEventListener("abort", onParentAbort);
      delete record.foregroundWaiter;
      delete record.running;
      delete record.controller;
      if (!this.disposed) drainDirect(record, this.host);
    });
    record.running = running;
    const file = this.store.outputFileFor(record.info.taskId);
    if (background) {
      this.armLifetime(record);
      void running.then((result) => this.notifier.notify(record, result));
      return startedResult(record, file, running);
    }
    // [W7-B1] 前台：转后台（background()）时等待者先行 resolve，工具调用立即返回
    const { waiter, promise } = foregroundWaiter(() => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
      delete record.onUpdate;
    });
    record.foregroundWaiter = waiter;
    const after = this.env.autoBackgroundAfterMs ?? 0;
    if (after > 0 && parent === undefined && record.info.workflow === undefined) {
      timer = setTimeout(() => this.background(record.info.taskId, "timeout"), after);
      timer.unref?.();
    }
    return Promise.race([running, promise]);
  }

  private async execute(
    record: TaskRecord,
    request: SubagentRequest,
    ama: AmaRunnerFactory,
    signal: AbortSignal,
    baseCwd: string = this.host.cwd,
  ): Promise<SubagentResult> {
    record.queued = true;
    try {
      await this.pool.acquire(signal);
    } catch {
      delete record.queued;
      return this.finish(record, { ...failed("aborted by user"), status: "aborted" });
    }
    delete record.queued;
    record.slot = true;
    try {
      const setup = this.env.modelConfig?.subagents?.worktreeSetup;
      await prepareTaskWorktree(record, baseCwd, this.host.manager.id, setup, signal);
      const handle = await this.handleFor(record, request, ama, signal);
      const onAbort = (): void => void handle.stop().catch(() => undefined);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      try {
        return this.finish(record, await handle.wait(), signal.aborted);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.finish(record, failed(`Sub-agent failed: ${message}`), signal.aborted);
    } finally {
      if (record.slot === true) {
        record.slot = false;
        this.pool.release();
      }
    }
  }

  private handleFor(
    record: TaskRecord,
    request: SubagentRequest,
    ama: AmaRunnerFactory,
    signal: AbortSignal,
  ): Promise<TaskHandle> {
    return startHandle(record, request, ama, signal, {
      runners: (agent) => this.env.runners?.(agent),
      // 嵌套记录取发起子会话的模式（只读子会话 = plan），不取根；只读请求一律 plan
      mode:
        request.readOnly === true
          ? "plan"
          : (record.spawner?.permissionMode ?? this.host.options.permission?.mode ?? "default"),
      touch: (taskId) => this.store.touch(taskId),
      emit: (event) => this.host.emit(event),
      sink: () => this.sink(),
    });
  }

  private sink(): ProgressSink {
    return {
      emit: (event) => this.host.emit(event),
      log: (level, message) => this.host.log(level, message),
      now: () => this.now(),
      appendTrace: (data) => appendTraceEntry(this.host, data), // [W6-C0]
    };
  }

  private finish(
    record: TaskRecord,
    result: SubagentResult,
    aborted = false,
  ): Promise<SubagentResult> {
    return finishRecord(
      {
        host: this.host,
        store: this.store,
        tasks: this.tasks,
        now: () => this.now(),
        sink: this.sink(),
      },
      record,
      result,
      aborted,
    );
  }

  /** 会话关闭：停止运行中的任务、释放保留的子会话。 */
  dispose(): void {
    if (this.disposed) return;
    for (const record of this.tasks.values()) {
      record.controller?.abort();
      const handle = record.handle;
      delete record.handle;
      if (handle !== undefined) void (handle.dispose?.() ?? handle.stop()).catch(() => undefined);
    }
    this.disposed = true;
    if (registries.get(this.host.manager.id) === this) registries.delete(this.host.manager.id);
    unregisterTaskControl(this.host.manager.id, this);
  }
}
