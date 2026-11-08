/**
 * 子 Agent 任务的句柄获取（从 subagent-registry.ts 拆出，保持 ≤ 600 行）。[W5-G]
 *
 * 续聊时复用保留的句柄（视图里发的消息走 `message(…, "send")`），否则按 runner 类型启动：ama 子会话
 * （session-subagent.ts 的工厂）或外部 / 宿主 runner；启动后记下会话引用并发 `subagent_start`。
 */

import type { SubagentRequest } from "../tools/types.js";
import type { AgentDefinition } from "../agents/types.js";
import type { SubagentRunner } from "../tools/types.js";
import {
  applyRunnerEvent,
  startEvent,
  type AmaRunnerSpec,
  type ProgressSink,
  type TaskHandle,
  type TaskRecord,
} from "../agents/task-record.js";
import type { PermissionMode } from "../permissions/types.js";
import type { SessionEvent } from "./types.js";

export interface HandleContext {
  runners(agent: AgentDefinition): SubagentRunner | undefined;
  /** 父会话的权限模式（子会话继承）。 */
  mode: PermissionMode;
  /** 句柄 LRU：复用时标记为最近使用。 */
  touch(taskId: string): void;
  emit(event: SessionEvent): void;
  sink(): ProgressSink;
}

export async function startHandle(
  record: TaskRecord,
  request: SubagentRequest,
  ama: (spec: AmaRunnerSpec) => SubagentRunner,
  signal: AbortSignal,
  ctx: HandleContext,
): Promise<TaskHandle> {
  const live = record.handle;
  const direct = record.directNext === true;
  delete record.directNext;
  if (live !== undefined) {
    ctx.touch(record.info.taskId);
    ctx.emit(startEvent(record, live));
    if (direct && live.message !== undefined) await live.message(request.prompt, "send");
    else await live.send(request.prompt);
    return live;
  }
  const ref = record.info.sessionRef;
  const runner =
    record.agent.runner === "ama"
      ? ama({
          taskId: record.info.taskId,
          agent: record.agent,
          request,
          ...(record.modelRef === undefined ? {} : { modelRef: record.modelRef }),
          cwd: record.cwd,
          ...(ref?.sessionFile === undefined ? {} : { resumeFile: ref.sessionFile }),
          isolated: record.worktree !== undefined,
          ...(direct ? { origin: "direct" } : {}),
        })
      : ctx.runners(record.agent);
  if (runner === undefined) throw new Error(`runner ${record.agent.runner} is not available`);
  const handle: TaskHandle = await runner.start({
    prompt: request.prompt,
    cwd: record.cwd,
    mode: ctx.mode,
    ...(record.modelRef === undefined ? {} : { model: record.modelRef }),
    ...(ref !== undefined && record.agent.runner !== "ama" ? { resume: ref.sessionId } : {}),
    ...(request.budgetUsd === undefined ? {} : { budgetUsd: request.budgetUsd }),
    taskId: record.info.taskId,
    signal,
    onEvent: (event) => applyRunnerEvent(record, event, ctx.sink()),
  });
  record.handle = handle;
  record.info.sessionRef = {
    runner: record.agent.runner,
    sessionId: handle.id,
    ...(handle.sessionFile === undefined ? {} : { sessionFile: handle.sessionFile }),
  };
  ctx.emit(startEvent(record, handle));
  return handle;
}
