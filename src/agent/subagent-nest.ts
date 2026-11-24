/**
 * 嵌套任务的注册表侧规则（多 Agent 工作流设计稿 §3.3）：父记录与深度校验、按本次运行的轮数 / 美元预算
 * （并行兄弟预留）、续聊范围、名额 park / unpark、记账与级联取消。[#317]
 *
 * 纯函数与小状态：只依赖任务记录，不依赖注册表（注册表 import 本文件）；子会话侧的构造
 * （`rootRegistryOf` / `nestedSpawner`）在 subagent-tree.ts。
 */

import type { NestedSpawner, SubagentPool, TaskRecord } from "../agents/task-record.js";
import type { SubagentRequest } from "../tools/types.js";

/** 缺省嵌套层数（`subagents.maxDepth`）：一层子任务再派一层。 */
export const DEFAULT_MAX_DEPTH = 2;
export const DEFAULT_TASK_TURNS = 30;

export interface RunLimits {
  maxTurns: number;
  budgetUsd?: number;
}

export interface NestPlan {
  parent: TaskRecord;
  depth: number;
  limits: RunLimits;
}

const usd = (value: number): string => `$${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;

/** 本次运行已用的回合数。 */
export function turnsUsed(record: TaskRecord): number {
  return Math.max(0, (record.info.turns ?? 0) - record.run.startTurns);
}

/** 本次运行自身的花费（不含后代）。 */
export function ownSpent(record: TaskRecord): number {
  return Math.max(0, (record.info.costUsd ?? 0) - record.run.startCostUsd);
}

/** 首跑请求里的 maxTurns / budgetUsd（续聊没给时沿用，再按当时父余额截断）。 */
const requested = new WeakMap<TaskRecord, { maxTurns?: number; budgetUsd?: number }>();

export function rememberRequest(record: TaskRecord, request: SubagentRequest): void {
  if (requested.has(record)) return;
  const first: { maxTurns?: number; budgetUsd?: number } = {};
  if (request.maxTurns !== undefined) first.maxTurns = request.maxTurns;
  if (request.budgetUsd !== undefined) first.budgetUsd = request.budgetUsd;
  requested.set(record, first);
}

/** 本次运行请求的上限：请求给的优先，其次首跑的值，最后类型缺省。 */
export function requestedLimits(
  record: TaskRecord | undefined,
  request: SubagentRequest,
  agentMaxTurns: number | undefined,
): RunLimits {
  const first = record === undefined ? undefined : requested.get(record);
  const limits: RunLimits = {
    maxTurns: request.maxTurns ?? first?.maxTurns ?? agentMaxTurns ?? DEFAULT_TASK_TURNS,
  };
  const budget = request.budgetUsd ?? first?.budgetUsd;
  if (budget !== undefined) limits.budgetUsd = budget;
  return limits;
}

/** §3.3 规则 1、2、7、8：父记录、深度、轮数与美元余额（并行兄弟的预留已扣）。 */
export function planNested(
  tasks: ReadonlyMap<string, TaskRecord>,
  parentTaskId: string,
  wanted: RunLimits,
  maxDepth: number,
): NestPlan | string {
  const parent = tasks.get(parentTaskId);
  if (parent === undefined || parent.info.status !== "running")
    return `Parent task ${parentTaskId} is not running.`;
  const depth = (parent.info.depth ?? 1) + 1;
  if (depth > maxDepth)
    return `Sub-agent depth limit reached (subagents.maxDepth = ${maxDepth}); do this part yourself.`;
  const turnsLeft = parent.run.maxTurns - turnsUsed(parent);
  if (turnsLeft < 1)
    return `Parent task ${parentTaskId} has no turns left for a sub-task; finish the work yourself.`;
  const limits: RunLimits = { maxTurns: Math.min(wanted.maxTurns, turnsLeft) };
  const budget = parent.run.budgetUsd;
  if (budget === undefined) {
    if (wanted.budgetUsd !== undefined) limits.budgetUsd = wanted.budgetUsd;
  } else {
    const spent = ownSpent(parent) + parent.run.childSpentUsd;
    const left = budget - spent - parent.run.reservedUsd;
    if (left <= 0)
      return (
        `Parent task ${parentTaskId} has no budget left for a sub-task ` +
        `(${usd(spent)} of ${usd(budget)} spent); finish the work yourself.`
      );
    limits.budgetUsd = Math.min(wanted.budgetUsd ?? left, left);
  }
  return { parent, depth, limits };
}

/** 续聊范围（§3.3 规则 5）：只能续聊自己启动的任务；带 workflow 的任务只接受同一运行的请求。 */
export function continuationRejection(
  record: TaskRecord,
  request: SubagentRequest,
): string | undefined {
  const flow = record.info.workflow;
  if (flow !== undefined && request.workflow?.runId !== flow.runId)
    return `Task ${record.info.taskId} belongs to workflow run ${flow.runId}; it cannot be continued here.`;
  if (record.info.parentTaskId !== request.parentTaskId)
    return `Task ${record.info.taskId} was started by another agent; you can only continue tasks you started.`;
  return undefined;
}

/** 起跑时给父记录预留子任务的美元（父有预算才预留）；返回预留额。 */
export function reserveBudget(parent: TaskRecord, limits: RunLimits): number {
  if (parent.run.budgetUsd === undefined || limits.budgetUsd === undefined) return 0;
  parent.run.reservedUsd += limits.budgetUsd;
  return limits.budgetUsd;
}

/** 子任务结束：退还预留，已结束子树的花费计入父。 */
export function settleChild(parent: TaskRecord, child: TaskRecord, reserved: number): void {
  parent.run.reservedUsd = Math.max(0, parent.run.reservedUsd - reserved);
  parent.run.childSpentUsd += ownSpent(child) + child.run.childSpentUsd;
}

/** park：所有校验都过之后才调；父持有名额且未 park 时让出名额，让子任务能跑。 */
export function parkParent(parent: TaskRecord, pool: SubagentPool): void {
  parent.nestedActive = (parent.nestedActive ?? 0) + 1;
  if (parent.slot === true && parent.parked !== true) {
    pool.release();
    parent.slot = false;
    parent.parked = true;
  }
}

/** 正在取回名额的共享 promise（同一父记录的并发 unpark 只 acquire 一次）。 */
const unparking = new WeakMap<TaskRecord, Promise<void>>();

/**
 * unpark：最后一个嵌套子任务结束（含失败、取消）后优先拿回名额。父已结束 / 被中止时不拿（只清 park 标记），
 * 拿到时父若已结束立即还回；并发的 unpark 复用同一次取回。
 */
export async function unparkParent(parent: TaskRecord, pool: SubagentPool): Promise<void> {
  parent.nestedActive = Math.max(0, (parent.nestedActive ?? 1) - 1);
  if (parent.nestedActive > 0 || parent.parked !== true) return;
  const signal = parent.controller?.signal;
  const alive = (): boolean => parent.controller !== undefined && parent.info.status === "running";
  if (signal === undefined || !alive()) {
    parent.parked = false;
    return;
  }
  let pending = unparking.get(parent);
  if (pending === undefined) {
    pending = (async () => {
      try {
        await pool.acquire(signal, { priority: true });
      } catch {
        parent.parked = false;
        return;
      }
      if (!alive()) {
        pool.release();
        parent.parked = false;
        return;
      }
      if ((parent.nestedActive ?? 0) > 0) {
        // 等待期间又有兄弟起跑并 park：名额还回去，保持 park
        pool.release();
        return;
      }
      parent.slot = true;
      parent.parked = false;
    })().finally(() => unparking.delete(parent));
    unparking.set(parent, pending);
  }
  await pending;
}

/** 记录结束：把它自身本次花费逐级回调给每个祖先会话（根会话靠 subagent_end 求和）。 */
export function chargeAncestors(
  tasks: ReadonlyMap<string, TaskRecord>,
  record: TaskRecord,
  cost: number,
): void {
  if (!(cost > 0)) return;
  let at: TaskRecord | undefined = record;
  while (at !== undefined && (at.info.depth ?? 1) >= 2) {
    (at.spawner as NestedSpawner | undefined)?.charge(cost);
    at = at.info.parentTaskId === undefined ? undefined : tasks.get(at.info.parentTaskId);
  }
}

/** 级联取消：中止所有在跑的后代。 */
export function cascadeAbort(tasks: ReadonlyMap<string, TaskRecord>, taskId: string): void {
  for (const child of tasks.values()) {
    if (child.info.parentTaskId !== taskId || child.info.status !== "running") continue;
    child.controller?.abort();
    cascadeAbort(tasks, child.info.taskId);
  }
}

/** 把本次运行截过的上限写进请求（ama 子会话与外部 runner 据此执行）。 */
export function deriveRequest(request: SubagentRequest, limits: RunLimits): SubagentRequest {
  const next: SubagentRequest = { ...request, maxTurns: limits.maxTurns };
  if (limits.budgetUsd !== undefined) next.budgetUsd = limits.budgetUsd;
  return next;
}

/** 续聊前置检查：未知任务、仍在运行、会话没存、续聊范围（§3.3 规则 5）。 */
export function continueBlocked(
  record: TaskRecord | undefined,
  request: SubagentRequest,
): string | undefined {
  const taskId = request.taskId as string;
  if (record === undefined) return `Unknown task ${taskId}.`;
  if (record.running !== undefined)
    return `Task ${taskId} is still running; use task_ctl wait or stop first.`;
  const ref = record.info.sessionRef;
  const resumable =
    record.agent.runner === "ama" ? ref?.sessionFile !== undefined : ref !== undefined;
  if (record.handle === undefined && !resumable)
    return `Task ${taskId} cannot be continued (its session was not saved).`;
  return continuationRejection(record, request);
}
