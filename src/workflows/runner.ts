/** [#318] 工作流入口：选单独运行还是交给宿主（§4.5–§4.6、§5.7）。 */
import { AmaError } from "../errors.js";
import type { AgentSessionImpl } from "../agent/session.js";
import { taskControl } from "../agents/task-control.js";
import type { SubagentResult } from "../tools/types.js";
import { runOnHost } from "./host-handoff.js";
import {
  WORKFLOW_CUSTOM_TYPE,
  type HostWorkflowHandler,
  type WorkflowFile,
  type WorkflowHost,
  type WorkflowRunHandle,
  type WorkflowRunOptions,
} from "./run-types.js";
import { runStandalone } from "./scheduler.js";
import { WORKFLOW_FORMAT_VERSION, type WorkflowDocument } from "./types.js";

type StandaloneRunner = typeof runStandalone;
const active = new Map<string, WorkflowRunHandle>();

function isFile(file: WorkflowFile | { workflow: WorkflowDocument }): file is WorkflowFile {
  const f = file as Partial<WorkflowFile>;
  return typeof f.id === "string" && typeof f.filePath === "string" && typeof f.hash === "string";
}

/**
 * 有宿主处理器、版本匹配且工作流来自文件 → 交给宿主；否则 ama 自己调度。
 * SDK 传入的内联文档一律单独运行。`standalone` 供测试注入。
 */
export function startWorkflow(
  host: WorkflowHost,
  file: WorkflowFile | { workflow: WorkflowDocument },
  options: WorkflowRunOptions & { hostHandler?: HostWorkflowHandler },
  standalone: StandaloneRunner = runStandalone,
): WorkflowRunHandle {
  const { hostHandler, ...runOptions } = options;
  if (hostHandler !== undefined && isFile(file)) {
    if (hostHandler.versions.includes(WORKFLOW_FORMAT_VERSION)) {
      return runOnHost(hostHandler, host, file, runOptions);
    }
    host.log(
      "warn",
      `host cannot run workflow version ${WORKFLOW_FORMAT_VERSION}; running it here`,
    );
  }
  const handle = standalone(host, file, runOptions);
  active.set(host.sessionId, handle);
  const release = (): void => {
    if (active.get(host.sessionId) === handle) active.delete(host.sessionId);
  };
  handle.wait().then(release, release);
  return handle;
}

/** 本会话在跑的单独运行（交给宿主的不算）。 */
export function activeWorkflow(sessionId: string): WorkflowRunHandle | undefined {
  return active.get(sessionId);
}

type AgentCheck = (name: string) => boolean;
const agentChecks = new Map<string, AgentCheck>();

/** 会话扩展登记「Agent 是否可用」（目录 + runner）；会话 dispose 时传 undefined 注销。 */
export function bindWorkflowAgents(sessionId: string, check: AgentCheck | undefined): void {
  if (check === undefined) agentChecks.delete(sessionId);
  else agentChecks.set(sessionId, check);
}

const WAIT_WINDOW_MS = 60_000;

export function workflowHostOf(session: AgentSessionImpl): WorkflowHost {
  const sessionId = session.manager.id;
  const control = () => taskControl(sessionId);
  return {
    sessionId,
    cwd: session.cwd,
    spawn: (request) => session.spawnSubagent(request),
    async wait(taskId, signal): Promise<SubagentResult> {
      const ctl = control();
      if (ctl === undefined) throw new AmaError("task_not_found", `No task ${taskId}.`);
      while (!signal.aborted) {
        const result = await ctl.wait(taskId, WAIT_WINDOW_MS, { signal });
        if (result !== undefined && result.status !== "running") return result;
      }
      throw new AmaError("cancelled", "Workflow wait was cancelled.");
    },
    tasks: () => control()?.list() ?? [],
    onTaskEvent(listener) {
      return session.subscribe((event) => {
        if (!event.type.startsWith("subagent_")) return;
        const e = event as { type: string; taskId: string; parentTaskId?: string; status?: string };
        listener({
          type: e.type,
          taskId: e.taskId,
          ...(e.parentTaskId === undefined ? {} : { parentTaskId: e.parentTaskId }),
          ...(e.status === undefined ? {} : { status: e.status }),
        });
      });
    },
    agentAvailable: (name) =>
      agentChecks.get(sessionId)?.(name) ?? (name === "ama" || name === "general"),
    emit: (update) => session.emit({ type: "workflow_update", ...update }),
    record: (data) =>
      void session.appendEntry({ type: "custom", customType: WORKFLOW_CUSTOM_TYPE, data }),
    log: (level, message) => session.log(level, message),
  };
}
