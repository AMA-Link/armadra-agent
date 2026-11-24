/**
 * [#318] ama 自己调度的单独运行（设计稿 §4.5）：依赖与并行、同角色串行续聊同一任务、gate、
 * collect 的验证与退回、运行预算、阶段、取消、快照。模型侧模块，不得 import `src/i18n`。
 */
import { AmaError } from "../errors.js";
import type { SubagentResult } from "../tools/types.js";
import { Cancelled, StepFailure, errorText, verdictOf } from "./scheduler-support.js";
import { checkRenderedPrompts, renderWorkflowPrompt } from "./render.js";
import { resolveWorkflowParams } from "./render.js";
import type {
  WorkflowFile,
  WorkflowGateDecision,
  WorkflowHost,
  WorkflowRunHandle,
  WorkflowRunOptions,
  WorkflowStepState,
} from "./run-types.js";
import { fixMessage, recollectMessage, stepOutputBlock, verifyInstruction } from "./step-prompt.js";
import type { CollectStep, PromptStep, WorkflowDocument, WorkflowStep } from "./types.js";

import { RunBase, active } from "./scheduler-run.js";

export function activeStandalone(sessionId: string): WorkflowRunHandle | undefined {
  return active.get(sessionId);
}

class Run extends RunBase {
  // ---- 单个步骤 ----
  protected async runStep(def: WorkflowStep, step: WorkflowStepState): Promise<void> {
    try {
      if (def.kind === "gate") await this.runGate(def.label, step);
      else if (def.kind === "prompt") await this.runPrompt(def, step);
      else await this.runCollect(def, step);
    } catch (e) {
      if (e instanceof Cancelled || this.ac.signal.aborted) {
        if (step.status === "running" || step.status === "waiting")
          this.finishStep(step, "cancelled");
      } else if (e instanceof StepFailure) this.fail(step, e.code, e.message);
      else this.fail(step, "step_failed", `Step ${step.id} failed: ${errorText(e)}`);
    }
  }

  protected async runPrompt(def: PromptStep, step: WorkflowStepState): Promise<void> {
    this.setPhase(step, "running");
    const body = renderWorkflowPrompt(def.prompt, this.state.params);
    await this.settle(step, await this.send(step, def.role, body));
  }

  /** 无 verify 的判定：终态 completed 且报告不是 failed / blocked。 */
  protected async settle(step: WorkflowStepState, r: SubagentResult): Promise<void> {
    const v = verdictOf(r);
    if (v.kind === "task_failed" || v.kind === "report_failed") {
      this.fail(step, "step_failed", `Step ${step.id} failed: ${v.reason}`);
      return;
    }
    this.record(step, r);
    this.finishStep(step, "done");
  }

  protected outputBlocks(def: CollectStep): string[] {
    const blocks: string[] = [];
    for (const id of def.from) {
      const out = this.output.get(id);
      const from = this.defs.get(id);
      if (out === undefined || from === undefined || from.kind === "gate") continue;
      blocks.push(stepOutputBlock(id, from.role, out.text, out.outputFile));
    }
    return blocks;
  }
  protected fromRoles(def: CollectStep): string[] {
    const roles: string[] = [];
    for (const id of def.from) {
      const from = this.defs.get(id);
      if (from !== undefined && from.kind !== "gate" && !roles.includes(from.role)) {
        roles.push(from.role);
      }
    }
    return roles;
  }

  protected async runCollect(def: CollectStep, step: WorkflowStepState): Promise<void> {
    const verify = def.verify;
    const prompt = renderWorkflowPrompt(def.prompt, this.state.params);
    if (verify == null) {
      this.setPhase(step, "collecting");
      const body = [prompt, ...this.outputBlocks(def)].join("\n\n");
      await this.settle(step, await this.send(step, def.role, body));
      return;
    }
    const roles = this.fromRoles(def);
    const max = this.maxRetries.get(def.id) ?? 2;
    const instruction = verifyInstruction(verify, roles);
    let attempt = 1;
    let body = [prompt, ...this.outputBlocks(def), instruction].join("\n\n");
    for (;;) {
      step.attempt = attempt;
      this.setPhase(step, "verifying");
      let r: SubagentResult;
      try {
        r = await this.send(step, def.role, body);
      } catch (e) {
        if (attempt === 1 || e instanceof StepFailure || e instanceof Cancelled) throw e;
        await this.escalate(step, "not_reopenable", `could not continue: ${errorText(e)}`, attempt);
        return;
      }
      const v = verdictOf(r);
      if (v.kind === "task_failed") {
        this.fail(step, "step_failed", `Step ${step.id} failed: ${v.reason}`);
        return;
      }
      if (v.kind === "ok") {
        this.record(step, r);
        this.finishStep(step, "done");
        return;
      }
      this.record(step, r);
      if (v.kind === "no_report") {
        await this.escalate(step, "unverified", "no report", attempt);
        return;
      }
      if (attempt > max) {
        await this.escalate(step, "exhausted", v.reason, attempt);
        return;
      }
      this.setPhase(step, "collecting");
      const sent = await this.sendBack(def, step, roles, v.reason, attempt, max);
      if (sent !== "ok") {
        if (sent.fixFailed !== undefined) this.fail(step, "step_failed", sent.fixFailed);
        else await this.escalate(step, "not_reopenable", v.reason, attempt);
        return;
      }
      body = [recollectMessage(attempt, max), ...this.outputBlocks(def), instruction].join("\n\n");
      attempt += 1;
    }
  }

  /** 把问题退回给点名的角色（没点名就退回全部 `from` 角色）并等它们修完。 */
  protected async sendBack(
    def: CollectStep,
    step: WorkflowStepState,
    roles: readonly string[],
    problems: string,
    attempt: number,
    max: number,
  ): Promise<"ok" | { fixFailed?: string }> {
    const named = roles.filter((r) => problems.includes(`[${r}]`));
    const targets = named.length > 0 ? named : roles;
    if (targets.some((r) => !this.roleTask.has(r))) return {};
    const outcomes = await Promise.all(
      targets.map((role) => this.fixRole(def, step, role, problems, attempt, max)),
    );
    for (const o of outcomes) if (o !== "ok") return o;
    return "ok";
  }

  protected async fixRole(
    def: CollectStep,
    collect: WorkflowStepState,
    role: string,
    problems: string,
    attempt: number,
    max: number,
  ): Promise<"ok" | { fixFailed?: string }> {
    const own = def.from
      .filter((id) => this.defs.get(id)?.kind !== "gate")
      .filter((id) => (this.defs.get(id) as PromptStep).role === role)
      .map((id) => this.step(id));
    // 汇总角色自己的锁已被 collect 步骤持有。
    const lock = role !== def.role;
    if (lock) await this.acquire(role);
    for (const s of own) {
      s.status = "running";
      delete s.endedAt;
      this.setPhase(s, "running");
    }
    let outcome: "ok" | { fixFailed?: string } = {};
    try {
      let r: SubagentResult;
      try {
        r = await this.send(own[own.length - 1]!, role, fixMessage(def.id, attempt, max, problems));
      } catch (e) {
        if (e instanceof StepFailure || e instanceof Cancelled) throw e;
        return {};
      }
      const v = verdictOf(r);
      if (v.kind === "task_failed" || v.kind === "report_failed") {
        const last = own[own.length - 1]!;
        this.record(last, r);
        outcome = { fixFailed: `Step ${last.id} failed: ${v.reason}` };
        this.fail(last, "step_failed", outcome.fixFailed!);
        return outcome;
      }
      this.record(own[own.length - 1]!, r);
      outcome = "ok";
      return outcome;
    } finally {
      for (const s of own) {
        if (s.status !== "running") continue;
        this.finishStep(s, this.ac.signal.aborted ? "cancelled" : "done");
      }
      if (lock) this.release(role);
    }
  }

  /** 用尽、未验证、无法重开：问人，没有人问就失败。`unattendedGate` 不作用于这里。 */
  protected async escalate(
    step: WorkflowStepState,
    reason: "exhausted" | "unverified" | "not_reopenable",
    summary: string,
    attempt: number,
  ): Promise<void> {
    const message =
      reason === "unverified"
        ? `Step ${step.id} was not verified (no report).`
        : `Step ${step.id} did not pass verification: ${summary}`;
    const asker = this.options.onVerifyFailed;
    let answer: "accept" | "fail" = "fail";
    if (asker !== undefined) {
      step.status = "waiting";
      this.setPhase(step, "waiting_human");
      const decision = new Promise<"accept" | "fail">((resolve) =>
        this.asking.set(step.id, (d) => resolve(d === "approve" ? "accept" : "fail")),
      );
      try {
        answer = await this.abortable(
          Promise.race([
            asker(
              {
                runId: this.runId,
                workflowId: this.state.workflowId,
                stepId: step.id,
                reason,
                summary,
                attempt,
              },
              this.ac.signal,
            ),
            decision,
          ]),
        );
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        answer = "fail";
      } finally {
        this.asking.delete(step.id);
      }
      step.status = "running";
    }
    if (answer === "accept") {
      step.warnings = [...(step.warnings ?? []), message.replace(/\.$/, "") + "; accepted."];
      this.finishStep(step, "done");
    } else this.fail(step, "verify_failed", message);
  }

  protected abortable<T>(p: Promise<T>): Promise<T> {
    const signal = this.ac.signal;
    if (signal.aborted) return Promise.reject(new Cancelled());
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(new Cancelled());
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  protected async runGate(label: string, step: WorkflowStepState): Promise<void> {
    const onGate = this.options.onGate;
    let decision: WorkflowGateDecision;
    let unattended = false;
    if (onGate === undefined) {
      unattended = true;
      decision = this.options.unattendedGate === "approve" ? "approve" : "reject";
    } else {
      step.status = "waiting";
      this.setPhase(step, "waiting_human");
      const completed = this.state.steps
        .filter((s) => s.status === "done" && s.kind !== "gate")
        .map((s) => ({ stepId: s.id, summary: this.summary.get(s.id) ?? "" }));
      const external = new Promise<WorkflowGateDecision>((resolve) =>
        this.asking.set(step.id, resolve),
      );
      try {
        decision = await this.abortable(
          Promise.race([
            onGate(
              {
                runId: this.runId,
                workflowId: this.state.workflowId,
                stepId: step.id,
                label,
                completed,
              },
              this.ac.signal,
            ),
            external,
          ]),
        );
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        decision = "reject";
      } finally {
        this.asking.delete(step.id);
      }
      step.status = "running";
    }
    step.decision = decision;
    if (decision === "approve") this.finishStep(step, "done");
    else {
      const why = unattended ? " (no one to ask; workflows.unattendedGate is reject)" : "";
      this.fail(step, "gate_rejected", `Gate ${step.id} was rejected${why}.`);
    }
  }
}

export function runStandalone(
  host: WorkflowHost,
  file: WorkflowFile | { workflow: WorkflowDocument },
  options: WorkflowRunOptions,
): WorkflowRunHandle {
  const workflow = file.workflow;
  if (active.has(host.sessionId)) {
    throw new AmaError("workflow_busy", "A workflow is already running in this session.");
  }
  const resolved = resolveWorkflowParams(workflow, options.params ?? {});
  if (!resolved.ok) throw new AmaError(resolved.code, resolved.message);
  const tooLong = checkRenderedPrompts(workflow, resolved.params);
  if (tooLong !== undefined) {
    throw new AmaError(
      "prompt_too_long",
      `Step ${tooLong.stepId} is longer than ${tooLong.limit} characters after parameters are filled in.`,
    );
  }
  for (const role of workflow.roles) {
    const agent = role.agentId === "ama" ? "general" : role.agentId;
    if (role.agentId.startsWith("custom:") || !host.agentAvailable(agent)) {
      throw new AmaError(
        "workflow_agent_unavailable",
        `Role ${role.id} uses agent ${role.agentId}, which is not available here.`,
      );
    }
  }
  const named = "id" in file;
  const run = new Run(
    host,
    workflow,
    {
      id: named ? file.id : "inline",
      source: named
        ? { scope: file.scope, filePath: file.filePath, hash: file.hash }
        : { scope: "user" },
    },
    resolved.params,
    options,
  );
  active.set(host.sessionId, run);
  run.start();
  return run;
}
