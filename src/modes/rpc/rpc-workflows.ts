/**
 * RPC 工作流命令（[#318]，设计稿 §4.7）：`get_workflows` / `run_workflow` / `respond_workflow_gate` /
 * `cancel_workflow`。进度走 `workflow_update` 事件（会话事件，同形）。
 *
 * 客户端声明 `workflow_gates` 才会等它作答：gate 与验证升级交 `respond_workflow_gate`；没声明时 gate 按
 * `workflows.unattendedGate`、验证升级一律失败。stdin 关闭后没人能作答，等着的 gate 按拒绝、验证升级按失败收口。
 */

import type { AgentSession } from "../../agent/types.js";
import { AgentSessionImpl } from "../../agent/session.js";
import type { Runtime } from "../../cli/runtime.js";
import { AmaError } from "../../errors.js";
import { hostWorkflowsOf } from "../../host/api-impl.js";
import type { HostWorkflowHandler, WorkflowRunHandle } from "../../workflows/run-types.js";
import { findWorkflow, runWorkflowOn, summariesFor } from "../../workflows/session-run.js";
import type { RpcCapability, RpcCommandMap, RpcWorkflowResults } from "../../rpc.js";

/** 一个 RPC 连接上的工作流运行表。 */
export class RpcWorkflows {
  private readonly runs = new Map<string, WorkflowRunHandle>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly closing = new AbortController();

  track(runId: string, handle: WorkflowRunHandle): void {
    this.runs.set(runId, handle);
    if (handle.host) return;
    const done = handle.wait().then(
      () => undefined,
      () => undefined,
    );
    const settled = done.finally(() => {
      this.runs.delete(runId);
      this.pending.delete(settled);
    });
    this.pending.add(settled);
  }

  get(runId: string): WorkflowRunHandle | undefined {
    return this.runs.get(runId);
  }

  /** 永不作答的询问：只在连接关闭时拒绝（调度器按 gate 拒绝 / 验证失败收口）。 */
  waitForClient<T>(): Promise<T> {
    return new Promise<T>((_resolve, reject) => {
      const signal = this.closing.signal;
      if (signal.aborted) reject(new Error("closed"));
      else signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
    });
  }

  /** stdin 关闭：撤下所有等人的询问，并等在途运行结束；`cancel`（SIGINT / SIGTERM）时先取消。 */
  async close(cancel = false): Promise<void> {
    this.closing.abort();
    if (cancel)
      for (const handle of this.runs.values())
        if (!handle.host) void handle.cancel().catch(() => undefined);
    await Promise.allSettled([...this.pending]);
  }
}

export interface RpcWorkflowContext {
  readonly runtime: Runtime;
  session(): AgentSession;
  capabilities: Set<RpcCapability>;
  workflows?: RpcWorkflows;
}

function table(ctx: RpcWorkflowContext): RpcWorkflows {
  return (ctx.workflows ??= new RpcWorkflows());
}

function lookup(ctx: RpcWorkflowContext) {
  const { runtime } = ctx;
  const dirs = runtime.config.workflows?.dirs;
  return {
    cwd: runtime.paths.cwd,
    configDir: runtime.paths.configDir,
    trusted: runtime.trust.trusted,
    ...(dirs === undefined ? {} : { dirs }),
  };
}

function hostHandlerOf(runtime: Runtime): HostWorkflowHandler | undefined {
  for (const handle of [runtime.host, ...(runtime.extensions ?? [])]) {
    const handler = handle === undefined ? undefined : hostWorkflowsOf(handle.api);
    if (handler !== undefined) return handler;
  }
  return undefined;
}

function checkParams(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new AmaError("invalid_arguments", "params must be an object of strings");
  for (const [name, v] of Object.entries(value)) {
    if (typeof v !== "string")
      throw new AmaError("invalid_arguments", `params.${name} must be a string`);
  }
  return value as Record<string, string>;
}

export const workflowHandlers = {
  get_workflows: async (_p: RpcCommandMap["get_workflows"], ctx: RpcWorkflowContext) => ({
    workflows: summariesFor(lookup(ctx)),
  }),

  run_workflow: async (
    p: RpcCommandMap["run_workflow"],
    ctx: RpcWorkflowContext,
  ): Promise<RpcWorkflowResults["run_workflow"]> => {
    if (typeof p.workflowId !== "string" || p.workflowId === "")
      throw new AmaError("invalid_arguments", "workflowId must be a non-empty string");
    const params = checkParams(p.params);
    const session = ctx.session();
    if (!(session instanceof AgentSessionImpl))
      throw new AmaError("not_implemented", "workflows need a session created by ama");
    const { runtime } = ctx;
    const runs = table(ctx);
    const file = findWorkflow(p.workflowId, lookup(ctx));
    const gates = ctx.capabilities.has("workflow_gates");
    const hostHandler = hostHandlerOf(runtime);
    const handle = runWorkflowOn(session, file, {
      ...(params === undefined ? {} : { params }),
      unattendedGate: runtime.config.workflows?.unattendedGate ?? "reject",
      ...(runtime.config.limits === undefined
        ? {}
        : {
            limits: {
              ...(runtime.config.limits.maxCostUsd === undefined
                ? {}
                : { maxCostUsd: runtime.config.limits.maxCostUsd }),
              ...(runtime.config.limits.maxTurns === undefined
                ? {}
                : { maxTurns: runtime.config.limits.maxTurns }),
            },
          }),
      ...(gates
        ? {
            onGate: () => runs.waitForClient<"approve" | "reject">(),
            onVerifyFailed: () => runs.waitForClient<"accept" | "fail">(),
          }
        : {}),
      ...(hostHandler === undefined ? {} : { hostHandler }),
    });
    if (!handle.host) {
      runs.track(handle.runId, handle);
      return { runId: handle.runId, host: false };
    }
    // 交给宿主：等宿主应答（只交出并起跑）；被拒时带宿主的 code 与 message
    const result = await handle.wait();
    if (result.error !== undefined) throw new AmaError(result.error.code, result.error.message);
    const runId = result.host?.runId ?? handle.runId;
    runs.track(runId, handle);
    return {
      runId,
      host: true,
      ...(result.host?.url === undefined ? {} : { url: result.host.url }),
    };
  },

  respond_workflow_gate: async (
    p: RpcCommandMap["respond_workflow_gate"],
    ctx: RpcWorkflowContext,
  ): Promise<RpcWorkflowResults["respond_workflow_gate"]> => {
    if (p.decision !== "approve" && p.decision !== "reject")
      throw new AmaError("invalid_arguments", "decision must be approve or reject");
    return { ok: table(ctx).get(p.runId)?.respondGate(p.stepId, p.decision) ?? false };
  },

  cancel_workflow: async (
    p: RpcCommandMap["cancel_workflow"],
    ctx: RpcWorkflowContext,
  ): Promise<RpcWorkflowResults["cancel_workflow"]> => {
    const handle = table(ctx).get(p.runId);
    if (handle === undefined) return { ok: false };
    await handle.cancel();
    return { ok: true };
  },
};
