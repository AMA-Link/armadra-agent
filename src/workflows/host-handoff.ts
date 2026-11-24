/** [#318] 交给宿主执行（只交出并起跑，§4.6、§5.7）。 */
import { randomUUID } from "node:crypto";
import { AmaError } from "../errors.js";
import { resolveWorkflowParams } from "./render.js";
import type {
  HostWorkflowHandler,
  WorkflowFile,
  WorkflowHost,
  WorkflowRunHandle,
  WorkflowRunOptions,
  WorkflowRunRecord,
  WorkflowRunResult,
  WorkflowRunStatus,
  WorkflowUpdate,
} from "./run-types.js";

/**
 * 把文件工作流交给宿主处理器：`run()` 只调用一次，ama 之后不镜像进度、不等结果、不能取消。
 * 结果在 `run()` 落定后记一条快照、发一条 `workflow_update`（`host: true`、无 `step`）。
 */
export function runOnHost(
  handler: HostWorkflowHandler,
  host: WorkflowHost,
  file: WorkflowFile,
  options: WorkflowRunOptions,
): WorkflowRunHandle {
  const given = resolveWorkflowParams(file.workflow, options.params ?? {});
  if (!given.ok) throw new AmaError(given.code, given.message);
  const params = given.params;
  const runId = `wf-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const title = file.workflow.title;
  const signal = options.signal ?? new AbortController().signal;

  const settle = async (): Promise<WorkflowRunResult> => {
    let status: WorkflowRunStatus = "running";
    let started: { runId: string; url?: string } | undefined;
    let error: WorkflowRunResult["error"];
    try {
      const result = await handler.run({
        workflowId: file.id,
        workflow: file.workflow,
        params,
        source: { scope: file.scope, filePath: file.filePath, hash: file.hash },
        sessionId: host.sessionId,
        cwd: host.cwd,
        signal,
      });
      started = { runId: result.runId, ...(result.url === undefined ? {} : { url: result.url }) };
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (code === "workflow_unsupported") {
        status = "waiting";
        error = { code, message };
      } else {
        status = "failed";
        error = { code: typeof code === "string" && code !== "" ? code : "step_failed", message };
      }
    }
    const result: WorkflowRunResult = {
      runId,
      workflowId: file.id,
      status,
      steps: [],
      outputs: [],
      ...(started === undefined ? {} : { host: started }),
      ...(error === undefined ? {} : { error }),
    };
    const record: WorkflowRunRecord = {
      runId,
      workflowId: file.id,
      title,
      source: { scope: file.scope, filePath: file.filePath, hash: file.hash },
      params,
      status,
      steps: [],
      startedAt,
      ...(status === "failed" ? { endedAt: Date.now() } : {}),
      ...(started === undefined ? {} : { host: started }),
      ...(error === undefined ? {} : { error }),
    };
    const update: WorkflowUpdate = { runId, workflowId: file.id, title, status, host: true };
    guarded(host, () => host.record(record));
    guarded(host, () => host.emit(update));
    guarded(host, () => options.onUpdate?.(update));
    return result;
  };
  const done = settle();

  return {
    runId,
    host: true,
    wait: () => done,
    cancel: () =>
      Promise.reject(
        new AmaError("workflow_unsupported", "This run is on the host; cancel it there."),
      ),
    respondGate: () => false,
  };
}

function guarded(host: WorkflowHost, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    host.log("warn", `workflow handoff: ${String(error)}`);
  }
}
