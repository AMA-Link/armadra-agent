/**
 * [#318] ama 自己调度的单独运行（设计稿 §4.5）：依赖与并行、同角色串行续聊同一任务、gate、
 * collect 的验证与退回、运行预算、阶段、取消、快照。模型侧模块，不得 import `src/i18n`。
 */
import { randomUUID } from "node:crypto";
import {} from "../errors.js";
import type { SubagentRequest, SubagentResult, SubagentWorkflowRef } from "../tools/types.js";
import {
  Cancelled,
  StepFailure,
  budgetMessage,
  errorText,
  firstLine,
  hasRunningChild,
} from "./scheduler-support.js";
import { cloneStep, runRecordOf, type WorkflowRunState } from "./record.js";
import { normalizeWorkflow } from "./render.js";
import {} from "./render.js";
import type {
  WorkflowGateDecision,
  WorkflowHost,
  WorkflowRunHandle,
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowStepPhase,
  WorkflowStepState,
} from "./run-types.js";
import { contractBlock } from "./step-prompt.js";
import type { WorkflowDocument, WorkflowRole, WorkflowStep } from "./types.js";

/** 每个会话同时只有一个单独运行（`workflow_busy`）。 */
export const active = new Map<string, WorkflowRunHandle>();

export abstract class RunBase implements WorkflowRunHandle {
  readonly runId = `wf-${randomUUID().slice(0, 8)}`;
  readonly host = false;
  protected readonly state: WorkflowRunState;
  protected readonly defs = new Map<string, WorkflowStep>();
  protected readonly roles = new Map<string, WorkflowRole>();
  protected readonly after: ReadonlyMap<string, readonly string[]>;
  protected readonly maxRetries: ReadonlyMap<string, number>;
  protected readonly ac = new AbortController();
  protected readonly roleTask = new Map<string, string>();
  protected readonly roleStarted = new Set<string>();
  protected readonly held = new Set<string>();
  protected readonly waiters = new Map<string, (() => void)[]>();
  protected readonly output = new Map<string, { text: string; outputFile?: string }>();
  protected readonly summary = new Map<string, string>();
  protected readonly basePhase = new Map<string, WorkflowStepPhase>();
  protected readonly asking = new Map<string, (d: WorkflowGateDecision) => void>();
  protected readonly warnedModes = new Set<string>();
  protected done!: Promise<WorkflowRunResult>;

  constructor(
    protected readonly host_: WorkflowHost,
    protected readonly workflow: WorkflowDocument,
    meta: { id: string; source: WorkflowRunState["source"] },
    params: Record<string, string>,
    protected readonly options: WorkflowRunOptions,
  ) {
    const n = normalizeWorkflow(workflow);
    this.after = n.after;
    this.maxRetries = n.maxRetries;
    for (const r of workflow.roles) this.roles.set(r.id, r);
    for (const s of workflow.steps) this.defs.set(s.id, s);
    this.state = {
      runId: this.runId,
      workflowId: meta.id,
      title: workflow.title,
      source: meta.source,
      params,
      status: "running",
      steps: workflow.steps.map((s) => ({
        id: s.id,
        kind: s.kind,
        status: "pending",
        ...(s.kind === "gate" ? {} : { roleId: s.role }),
      })),
      startedAt: Date.now(),
    };
    const link = (): void => this.ac.abort();
    if (options.signal?.aborted) link();
    else options.signal?.addEventListener("abort", link, { once: true });
  }

  start(): void {
    this.done = this.main();
  }
  wait(): Promise<WorkflowRunResult> {
    return this.done;
  }
  async cancel(): Promise<void> {
    this.ac.abort();
    await this.done;
  }
  respondGate(stepId: string, decision: WorkflowGateDecision): boolean {
    const resolve = this.asking.get(stepId);
    if (resolve === undefined) return false;
    resolve(decision);
    return true;
  }

  // ---- 状态与发布 ----
  protected step(id: string): WorkflowStepState {
    return this.state.steps.find((s) => s.id === id)!;
  }
  protected publish(step?: WorkflowStepState): void {
    // 记录与事件发布失败（会话已关、宿主抛错）只记 warn，不让运行卡死在 workflow_busy
    try {
      this.host_.record(runRecordOf(this.state));
      const update = {
        runId: this.runId,
        workflowId: this.state.workflowId,
        title: this.state.title,
        status: this.state.status,
        host: false,
        ...(step === undefined ? {} : { step: cloneStep(step) }),
      };
      this.host_.emit(update);
      try {
        this.options.onUpdate?.(update);
      } catch (e) {
        this.host_.log("warn", `workflow onUpdate failed: ${errorText(e)}`);
      }
    } catch (e) {
      try {
        this.host_.log("warn", `workflow publish failed: ${errorText(e)}`);
      } catch {
        // 日志也失败时放弃
      }
    }
  }
  protected setPhase(step: WorkflowStepState, phase: WorkflowStepPhase | undefined): void {
    if (phase === undefined) delete step.phase;
    else step.phase = phase;
    if (phase !== undefined && phase !== "waiting_children" && phase !== "waiting_human") {
      this.basePhase.set(step.id, phase);
    }
    this.publish(step);
  }
  protected finishStep(
    step: WorkflowStepState,
    status: "done" | "failed" | "skipped" | "cancelled",
    error?: string,
  ): void {
    step.status = status;
    delete step.phase;
    step.endedAt = Date.now();
    if (error !== undefined) step.error = error;
    this.publish(step);
  }
  protected fail(step: WorkflowStepState, code: string, message: string): void {
    this.state.error ??= { code, message };
    this.finishStep(step, "failed", message);
  }

  // ---- 主循环 ----
  protected async main(): Promise<WorkflowRunResult> {
    try {
      return await this.loop();
    } finally {
      active.delete(this.host_.sessionId); // 无论如何结束都释放会话（否则永久 workflow_busy）
    }
  }

  private async loop(): Promise<WorkflowRunResult> {
    this.publish();
    const unsubscribe = this.host_.onTaskEvent(() => this.refreshPhases());
    const inflight = new Set<Promise<void>>();
    try {
      for (;;) {
        if (!this.ac.signal.aborted) {
          this.skipBlocked();
          for (const def of this.workflow.steps) {
            const step = this.step(def.id);
            if (step.status !== "pending" || !this.ready(def)) continue;
            const lock = def.kind === "gate" ? undefined : def.role;
            if (lock !== undefined && this.held.has(lock)) continue;
            if (lock !== undefined) this.held.add(lock);
            step.status = "running";
            step.startedAt = Date.now();
            this.publish(step);
            const p: Promise<void> = this.runStep(def, step).finally(() => {
              inflight.delete(p);
              if (lock !== undefined) this.release(lock);
            });
            inflight.add(p);
          }
        }
        if (inflight.size === 0) break;
        await Promise.race(inflight);
      }
    } catch (e) {
      this.state.error ??= { code: "step_failed", message: errorText(e) };
      // 在跑的步骤任务一并取消，等它们收尾
      this.ac.abort();
      await Promise.allSettled(inflight);
    } finally {
      unsubscribe();
    }
    return this.conclude();
  }

  protected ready(def: WorkflowStep): boolean {
    return (this.after.get(def.id) ?? []).every((id) => this.step(id).status === "done");
  }
  protected skipBlocked(): void {
    for (let changed = true; changed;) {
      changed = false;
      for (const def of this.workflow.steps) {
        const step = this.step(def.id);
        if (step.status !== "pending") continue;
        const blocked = (this.after.get(def.id) ?? []).some((id) =>
          ["failed", "skipped", "cancelled"].includes(this.step(id).status),
        );
        if (blocked) {
          this.finishStep(step, "skipped");
          changed = true;
        }
      }
    }
  }

  protected conclude(): WorkflowRunResult {
    const aborted = this.ac.signal.aborted;
    for (const step of this.state.steps) {
      if (step.status === "pending") this.finishStep(step, aborted ? "cancelled" : "skipped");
      else if (step.status === "running" || step.status === "waiting") {
        this.finishStep(step, "cancelled");
      }
    }
    const steps = this.state.steps;
    const failed = steps.some((s) => s.status === "failed");
    if (aborted && steps.some((s) => s.status === "cancelled")) {
      this.state.status = "cancelled";
      this.state.error = { code: "cancelled", message: "The run was cancelled." };
    } else if (failed || this.state.error !== undefined) {
      this.state.status = "failed";
    } else this.state.status = "succeeded";
    this.state.endedAt = Date.now();
    this.publish();
    const successors = new Set([...this.after.values()].flat());
    const outputs = this.workflow.steps
      .filter((s) => s.kind !== "gate" && !successors.has(s.id) && this.output.has(s.id))
      .map((s) => ({ stepId: s.id, text: this.output.get(s.id)!.text }));
    return {
      runId: this.runId,
      workflowId: this.state.workflowId,
      status: this.state.status,
      steps: steps.map(cloneStep),
      outputs,
      ...(this.state.error === undefined ? {} : { error: { ...this.state.error } }),
    };
  }

  // ---- 阶段 ----
  protected refreshPhases(): void {
    const tasks = this.host_.tasks();
    for (const step of this.state.steps) {
      if (step.status !== "running") continue;
      const own = tasks.find(
        (t) => t.workflow?.runId === this.runId && t.workflow.stepId === step.id,
      );
      const taskId = step.taskId ?? own?.taskId;
      if (taskId === undefined) continue;
      let dirty = step.taskId === undefined;
      step.taskId = taskId;
      const childRunning = hasRunningChild(tasks, taskId);
      const phase = childRunning ? "waiting_children" : (this.basePhase.get(step.id) ?? "running");
      if (step.phase !== phase) {
        step.phase = phase;
        dirty = true;
      }
      if (dirty) this.publish(step);
    }
  }

  // ---- 角色锁（修复续聊用） ----
  protected async acquire(role: string): Promise<void> {
    if (!this.held.has(role)) {
      this.held.add(role);
      return;
    }
    await new Promise<void>((resolve) => {
      const list = this.waiters.get(role) ?? [];
      list.push(resolve);
      this.waiters.set(role, list);
    });
  }
  protected release(role: string): void {
    const next = this.waiters.get(role)?.shift();
    if (next === undefined) this.held.delete(role);
    else next();
  }

  // ---- 与任务对话 ----
  protected async send(
    step: WorkflowStepState,
    roleId: string,
    body: string,
  ): Promise<SubagentResult> {
    const limit = budgetMessage(this.host_.tasks(), this.runId, this.options.limits);
    if (limit !== undefined) throw new StepFailure("limit_reached", limit);
    const role = this.roles.get(roleId)!;
    const ref: SubagentWorkflowRef = {
      runId: this.runId,
      workflowId: this.state.workflowId,
      stepId: step.id,
      roleId,
    };
    const common = {
      description: `${this.state.workflowId}/${step.id}`,
      parentToolCallId: `workflow:${this.runId}:${step.id}`,
      background: false,
      workflow: ref,
      signal: this.ac.signal,
    };
    const taskId = this.roleTask.get(roleId);
    let request: SubagentRequest;
    if (taskId !== undefined) {
      request = {
        ...common,
        prompt: body,
        taskId,
        ...(role.permissionMode === "plan" ? { readOnly: true } : {}),
      };
    } else {
      const contract =
        this.workflow.contract == null ? "" : contractBlock(this.workflow.contract, roleId);
      request = {
        ...common,
        prompt: [contract, body].filter((p) => p !== "").join("\n\n"),
        agent: role.agentId === "ama" ? "general" : role.agentId,
        ...(role.model ? { model: role.model } : {}),
        ...(role.tier ? { tier: role.tier } : {}),
        ...(role.worktree ? { isolation: "worktree" as const } : {}),
        ...(role.permissionMode === "plan" ? { readOnly: true } : {}),
      };
      this.warnMode(role);
    }
    this.roleStarted.add(roleId);
    if (taskId !== undefined) step.taskId = taskId;
    let result: SubagentResult;
    try {
      result = await this.host_.spawn(request);
      if (result.status === "running" && result.taskId !== undefined) {
        result = await this.host_.wait(result.taskId, this.ac.signal);
      }
    } catch (e) {
      if (this.ac.signal.aborted) throw new Cancelled();
      throw e;
    }
    if (this.ac.signal.aborted) throw new Cancelled();
    if (result.taskId !== undefined) {
      this.roleTask.set(roleId, result.taskId);
      step.taskId = result.taskId;
    }
    return result;
  }
  protected warnMode(role: WorkflowRole): void {
    const mode = role.permissionMode;
    if ((mode === "auto-edit" || mode === "full-auto") && !this.warnedModes.has(role.id)) {
      this.warnedModes.add(role.id);
      this.host_.log(
        "warn",
        `role ${role.id} asks for permission mode ${mode}; the session mode is not widened`,
      );
    }
  }

  protected record(step: WorkflowStepState, r: SubagentResult): void {
    this.output.set(step.id, {
      text: r.text,
      ...(r.outputFile === undefined ? {} : { outputFile: r.outputFile }),
    });
    this.summary.set(step.id, r.report?.summary || firstLine(r.text));
    if (r.outputFile !== undefined) step.outputFile = r.outputFile;
  }

  protected abstract runStep(def: WorkflowStep, step: WorkflowStepState): Promise<void>;
}
