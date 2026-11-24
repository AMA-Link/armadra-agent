/**
 * `ama -p --workflow <id> [--param name=value]…`（设计 §4.7、§4.9）：无人值守运行一个工作流。
 *
 * - 工作流按 config `workflows.dirs`、用户级、项目级（需信任；未信任的目录在 stderr 提示）发现；不接受提示。
 * - gate 按 `workflows.unattendedGate`（缺省 reject，不弹确认）；验证失败一律失败。
 * - 有宿主处理器且版本匹配时交给宿主（只交出并起跑）：stdout 打印 url 或 runId，退出 0；
 *   宿主返回 `workflow_unsupported` 表示等人确认 → 退出 10。
 * - 输出：`text` 把各步 `outputs` 以空行分隔写到 stdout；`json` 一个 result 对象（含 `workflow` 与收到的
 *   `workflowUpdates`）；`stream-json` 每个会话事件一行（含 `workflow_update`）再接一行 result。
 * - 退出码：成功 / 已交给宿主 0、步骤失败或验证失败 1、找不到 / 无效 / 参数错 2、到预算上限 8、
 *   gate 被拒 / 宿主转人工确认 10；SIGINT 130、SIGTERM 143（先取消运行）。
 */

import type { AgentSessionImpl } from "../../agent/session.js";
import { resolveLimits } from "../../agent/limits.js";
import { currentSession } from "../../cli/compose-session.js";
import type { ModeContext } from "../../cli/deps.js";
import { ExitCode } from "../../cli/exit-codes.js";
import type { Runtime } from "../../cli/runtime.js";
import { hostWorkflowsOf } from "../../host/api-impl.js";
import { msg } from "../../i18n/index.js";
import { discoverWorkflows, workflowSources } from "../../workflows/discover.js";
import { startWorkflow, workflowHostOf } from "../../workflows/runner.js";
import type {
  HostWorkflowHandler,
  WorkflowRunResult,
  WorkflowUpdate,
} from "../../workflows/run-types.js";
import { errorText, onStdoutClosed, onTerminationSignals } from "../shared.js";
import { toJsonLine, toWireEvent } from "./json-event.js";

type Start = typeof startWorkflow;

/** 起跑前就拒绝的错误码 → 用法类错误（2）；其余运行期错误 1。 */
const START_USAGE_CODES: ReadonlySet<string> = new Set([
  "workflow_not_found",
  "invalid_workflow",
  "missing_param",
  "invalid_param",
  "prompt_too_long",
  "workflow_agent_unavailable",
]);

function hostHandlerOf(runtime: Runtime): HostWorkflowHandler | undefined {
  for (const handle of [runtime.host, ...(runtime.extensions ?? [])]) {
    const handler = handle === undefined ? undefined : hostWorkflowsOf(handle.api);
    if (handler !== undefined) return handler;
  }
  return undefined;
}

function exitCodeOf(result: WorkflowRunResult): number {
  if (result.status === "succeeded") return ExitCode.Ok;
  if (result.host !== undefined && result.status === "running") return ExitCode.Ok;
  const code = result.error?.code;
  if (code === "limit_reached") return ExitCode.LimitReached;
  if (code === "gate_rejected" || result.status === "waiting") return ExitCode.WorkflowStopped;
  return ExitCode.RuntimeError;
}

export async function runPrintWorkflow(
  runtime: Runtime,
  context: ModeContext,
  start: Start = startWorkflow,
): Promise<number> {
  const { io, args } = context;
  const format = args.outputFormat ?? "text";
  const m = msg().print.print;
  const id = args.workflow ?? "";

  const discovery = discoverWorkflows(
    workflowSources({
      cwd: runtime.paths.cwd,
      configDir: runtime.paths.configDir,
      ...(runtime.config.workflows?.dirs === undefined
        ? {}
        : { configDirs: runtime.config.workflows.dirs }),
    }),
    { trusted: runtime.trust.trusted },
  );
  for (const dir of discovery.skippedUntrusted) io.stderr(m.workflowUntrusted(dir));
  const file = discovery.workflows.find((candidate) => candidate.id === id);
  if (file === undefined) {
    const invalid = discovery.summaries.find((summary) => summary.id === id && !summary.valid);
    io.stderr(
      invalid === undefined ? m.workflowNotFound(id) : m.workflowInvalid(id, invalid.error ?? ""),
    );
    return ExitCode.Usage;
  }

  const session = currentSession(runtime);
  const updates: WorkflowUpdate[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "workflow_update") {
      const { type: _type, ...update } = event;
      updates.push(update as WorkflowUpdate);
    }
    if (format === "stream-json") io.stdout(`${toJsonLine(toWireEvent(event))}\n`);
  });
  const limits = resolveLimits(runtime.config.limits, {
    maxTurns: args.maxTurns,
    maxCostUsd: args.maxCostUsd,
  });
  const hostHandler = hostHandlerOf(runtime);
  const controller = new AbortController();
  let signalled: number | undefined;
  let handle: ReturnType<Start> | undefined;
  const cancel = (): void => {
    controller.abort();
    void handle?.cancel().catch(() => undefined);
  };
  const offSignals = onTerminationSignals((code) => {
    signalled ??= code;
    cancel();
  });
  let stdoutClosed = false;
  const offEpipe = onStdoutClosed(() => {
    stdoutClosed = true;
    cancel();
  });

  let result: WorkflowRunResult | undefined;
  let failure: { code: string; message: string } | undefined;
  try {
    handle = start(workflowHostOf(session as AgentSessionImpl), file, {
      params: args.workflowParams ?? {},
      signal: controller.signal,
      unattendedGate: runtime.config.workflows?.unattendedGate ?? "reject",
      ...(limits === undefined ? {} : { limits }),
      ...(hostHandler === undefined ? {} : { hostHandler }),
    });
    result = await handle.wait();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    failure = { code: typeof code === "string" ? code : "step_failed", message: errorText(error) };
  } finally {
    offSignals();
    offEpipe();
    unsubscribe();
  }

  if (format === "json" || format === "stream-json") {
    io.stdout(
      `${toJsonLine({
        type: "result",
        sessionId: session.state.sessionId,
        workflowId: id,
        ...(result === undefined ? {} : { workflow: result }),
        ...(failure === undefined ? {} : { error: failure }),
        workflowUpdates: updates,
      })}\n`,
    );
  } else if (result !== undefined && result.status === "succeeded") {
    const text = result.outputs.map((output) => output.text.trim()).filter((t) => t !== "");
    if (text.length > 0) io.stdout(`${text.join("\n\n")}\n`);
  }

  if (signalled !== undefined) return signalled;
  if (stdoutClosed) return ExitCode.Ok;
  if (failure !== undefined) {
    io.stderr(`ama: ${failure.message}\n`);
    return START_USAGE_CODES.has(failure.code) ? ExitCode.Usage : ExitCode.RuntimeError;
  }
  if (result === undefined) return ExitCode.RuntimeError;
  if (result.host !== undefined) {
    const where = result.host.url ?? result.host.runId;
    if (format === "text") io.stdout(`${where}\n`);
    io.stderr(m.workflowOnHost(where));
  } else if (result.error !== undefined) {
    io.stderr(
      result.status === "waiting"
        ? m.workflowWaitingHost(result.error.message)
        : `ama: ${result.error.message}\n`,
    );
  } else if (result.status === "cancelled") io.stderr(m.workflowCancelled);
  return exitCodeOf(result);
}
