/**
 * `task_ctl` 工具：查看 / 等待 / 停止后台子 Agent 任务，读输出，向任务追加消息
 * （docs/history/wave5-plan.md §7.3，D13）。[W5-C0 桩 → W5-G]
 *
 * - 与 `task` 同进退（预设、`--tools`、`disable("task")`，见 registry.ts 的 `TOOL_COMPANIONS`）；
 * - 控制面按会话 id 取（agents/task-control.ts，注册表登记）；子会话里（depth ≥ 1）不可用——工具表
 *   与父一致，运行时拒绝；
 * - `wait` / `output` 是轮询类调用（`annotations.pollable`，重复调用检测豁免）；
 * - `send` = 续聊放后台：等价于 `task{taskId, prompt, background:true}`，完成后同样收到通知。
 * - [#242] `coordinator` 预设下 `wait` 的超时封顶 `COORDINATOR_WAIT_MAX_MS`（协调者不阻塞，见
 *   `bindTaskCtlWaitCap`）；其它预设不变。
 * - [W7-B1] `wait` 被转后台（`background()`，TUI `Ctrl+B` / RPC `background_task`）打断时立即返回固定
 *   文案，要求模型不要再等。
 * - [#267] `extend` = 给后台任务续命一次（`timeoutMs` 为增量，缺省与 `subagents.backgroundMaxMs` 相同，封顶一个
 *   上限）；到点被停止的任务经提醒通道告知模型（agent/subagent-lifetime.ts）。
 * - [#268] resume 后重建为 `interrupted` 的任务：`list` 行、`output` 头部与 `wait` 都附同一句（上一次运行
 *   没结束就停了，副作用可能只做了一半，重复外部动作前先核实）。
 */

import { extendTaskText } from "../agent/subagent-lifetime.js";
import { capTaskText, formatTokens, waitDetachedText } from "../agents/result.js";
import { taskControl } from "../agents/task-control.js";
import { nestedTaskRejection } from "./task.js";
import type { TaskInfo, ToolContext, ToolDefinition, ToolResult } from "./types.js";

export const TASK_CTL_TOOL = "task_ctl";
export const DEFAULT_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 600_000;
/** [#242] `coordinator` 预设下 `wait` 的超时上限（毫秒）。 */
export const COORDINATOR_WAIT_MAX_MS = 5_000;

const waitCaps = new WeakMap<object, number>();

/** [#268] 被打断（上一次运行异常结束）的任务：固定英文，`list` / `output` / `wait` 共用。 */
export const INTERRUPTED_TASK_NOTE =
  "it was interrupted when a previous run of this session ended abruptly, so its side effects may be " +
  "partial; inspect the workspace, git history and external state before repeating any of its actions";

/**
 * [#242] 组装根把 `wait` 的超时上限绑到 `task_ctl` 工具（`coordinator` 预设）；没绑定按 `MAX_WAIT_MS`。
 * 工具描述与参数 schema 不变（其它预设逐字节不变）；被封顶时在超时回复里说明。
 */
export function bindTaskCtlWaitCap(tool: ToolDefinition | undefined, capMs: number): void {
  if (tool !== undefined) waitCaps.set(tool, capMs);
}

export interface TaskCtlInput {
  action: "list" | "wait" | "stop" | "output" | "send" | "extend";
  taskId?: string;
  /** wait：等待时长；[#267] extend：续命增量。 */
  timeoutMs?: number;
  /** send：追加给任务的消息。 */
  prompt?: string;
}

function fail(message: string): ToolResult {
  return { content: message, isError: true };
}

function line(task: TaskInfo, now: number): string {
  const parts = [task.taskId, task.agent, task.status];
  if (task.turns !== undefined) parts.push(`${task.turns} turns`);
  if (task.usage !== undefined) parts.push(`${formatTokens(task.usage.totalTokens)} tokens`);
  parts.push(`${Math.round(((task.endedAt ?? now) - task.startedAt) / 1000)}s`);
  if (task.background) parts.push("background");
  const text = parts.join(" · ");
  const described = task.description === "" ? text : `${text} — ${task.description}`;
  return task.status === "interrupted" ? `${described} (${INTERRUPTED_TASK_NOTE})` : described;
}

async function send(input: TaskCtlInput, ctx: ToolContext): Promise<ToolResult> {
  if (input.prompt === undefined || input.prompt.trim() === "")
    return fail("send needs a non-empty prompt");
  if (ctx.spawnSubagent === undefined) return fail("Sub-agents are not available here.");
  const result = await ctx.spawnSubagent({
    prompt: input.prompt,
    taskId: input.taskId as string,
    background: true,
    parentToolCallId: ctx.toolCallId,
    signal: ctx.signal,
  });
  return { content: result.text, isError: result.isError };
}

export function createTaskCtlTool(): ToolDefinition<TaskCtlInput> {
  const tool: ToolDefinition<TaskCtlInput> = {
    name: TASK_CTL_TOOL,
    label: "TaskCtl",
    description:
      "Manage sub-agent tasks started by task: list them, wait for one, stop it, read its " +
      "output, send it a follow-up message (runs in background), or extend a background task's " +
      "lifetime once.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "wait", "stop", "output", "send", "extend"] },
        taskId: { type: "string", description: "Required except for list" },
        timeoutMs: {
          type: "number",
          description: `wait: how long (default ${DEFAULT_WAIT_MS}); extend: extra lifetime in ms`,
        },
        prompt: { type: "string", description: "send only" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    permission: "read",
    executionMode: "parallel",
    annotations: { pollable: true },
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.depth >= 1)
        return fail(
          nestedTaskRejection(ctx, "task_ctl", "task_ctl is not available inside a sub-agent."),
        );
      const control = taskControl(ctx.sessionId);
      if (input.action === "list") {
        const tasks = control?.list() ?? ctx.tasks?.list() ?? [];
        if (tasks.length === 0) return { content: "No sub-agent tasks." };
        const now = Date.now();
        return { content: tasks.map((task) => line(task, now)).join("\n") };
      }
      const taskId = input.taskId;
      if (taskId === undefined || taskId === "") return fail(`${input.action} needs taskId`);
      const info = control?.get(taskId);
      if (control === undefined || info === undefined) return fail(`Unknown task ${taskId}.`);
      switch (input.action) {
        case "send":
          return send(input, ctx);
        case "output": {
          const text = control.output(taskId) ?? "";
          const head =
            info.status === "running"
              ? `Task ${taskId} is running; output so far:`
              : info.status === "interrupted"
                ? `Task ${taskId} was interrupted (${INTERRUPTED_TASK_NOTE}); output so far:`
                : "";
          const body = capTaskText(text, info.outputFile).text || "(no output yet)";
          return { content: head === "" ? body : `${head}\n${body}` };
        }
        case "extend": {
          const ms = input.timeoutMs;
          if (ms !== undefined && (!Number.isFinite(ms) || ms <= 0))
            return fail("timeoutMs for extend must be a positive number of milliseconds");
          const outcome = control.extend(taskId, ms);
          return { content: extendTaskText(taskId, outcome), isError: !outcome.ok };
        }
        case "stop": {
          const result = await control.stop(taskId);
          return {
            content: `Task ${taskId} ${result?.status ?? control.get(taskId)?.status ?? "stopped"}.`,
          };
        }
        case "wait": {
          const cap = Math.min(waitCaps.get(tool) ?? MAX_WAIT_MS, MAX_WAIT_MS);
          const wanted = Math.min(Math.max(input.timeoutMs ?? DEFAULT_WAIT_MS, 0), MAX_WAIT_MS);
          const timeout = Math.min(wanted, cap);
          const signal = control.detachSignal(taskId);
          const result = await control.wait(taskId, timeout, { signal });
          if (result === undefined && signal.aborted) return { content: waitDetachedText(taskId) };
          if (result === undefined && control.get(taskId)?.status === "interrupted")
            return { content: `Task ${taskId} was interrupted (${INTERRUPTED_TASK_NOTE}).` };
          if (result === undefined) {
            const turns = control.get(taskId)?.turns ?? 0;
            const capped =
              wanted > timeout
                ? ` Waits are capped at ${Math.round(timeout / 1000)}s here; do not block on it: keep working, a <task-notification> follows when it finishes.`
                : "";
            return {
              content: `Task ${taskId} is still running (${turns} turns so far). Wait again or stop it.${capped}`,
            };
          }
          return {
            content: `[task ${taskId} ${result.status ?? "completed"}]\n${result.text}`,
            isError: result.isError,
          };
        }
        default:
          return fail(`unknown action ${String(input.action)}`);
      }
    },
  };
  return tool;
}
