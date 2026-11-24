/**
 * `/workflow` 斜杠命令（line 模式与交互模式共用，多 Agent 工作流设计稿 §4.7）。[#318]
 *
 * 子命令：`list`、`show <id>`、`run <id> [name=value …]`、`save [id] [--user]`、`cancel`。
 * 界面经 `CommandContext.workflow`（`WorkflowUi`）提供选择框与进度通知；没有界面（管道、测试）时
 * `run` 不预览直接起跑，gate 按 `workflows.unattendedGate`、验证升级一律失败。
 */

import { existsSync } from "node:fs";
import { AgentSessionImpl } from "../agent/session.js";
import { registryOf } from "../agent/subagent-registry.js";
import { rebuildRecords } from "../agents/task-record.js";
import { resolveConfigDir } from "../config/paths.js";
import { AmaError } from "../errors.js";
import { hostWorkflowsOf } from "../host/api-impl.js";
import { msg } from "../i18n/index.js";
import { createWorkflowSaveTool } from "../tools/workflow-save.js";
import type { ToolContext } from "../tools/types.js";
import {
  discoverWorkflows,
  resolveWorkflowTarget,
  workflowSources,
  workflowTargetPath,
  type WorkflowDiscovery,
} from "../workflows/discover.js";
import { formatWorkflowFile } from "../workflows/file.js";
import { workflowFromTasks } from "../workflows/from-tasks.js";
import { resolveWorkflowParams } from "../workflows/render.js";
import type {
  HostWorkflowHandler,
  WorkflowFile,
  WorkflowRunHandle,
  WorkflowUpdate,
} from "../workflows/run-types.js";
import { activeWorkflow, startWorkflow, workflowHostOf } from "../workflows/runner.js";
import { WORKFLOW_PARAM_PATTERN } from "../workflows/types.js";
import type { CommandContext, CommandResult } from "./commands-core.js";
import { workflowPrompts, type ChooseFn } from "./interactive/workflow-gate.js";
import {
  listLines,
  previewLines,
  showLines,
  statusText,
  stepProgressLine,
  type RoleTargets,
} from "./interactive/workflow-view.js";

/** 界面提供的能力。 */
export interface WorkflowUi {
  choose: ChooseFn;
  notice(text: string, level?: "info" | "warn" | "error"): void;
  /** 等运行结束再返回（line 模式：运行期间不收下一行）。 */
  wait?: boolean;
}

const handled = (lines: readonly string[]): CommandResult => ({
  kind: "handled",
  message: lines.join("\n"),
});

const bad = (text: string): AmaError =>
  new AmaError("invalid_arguments", msg().workflows.param.bad(text));

/** 按空白切词；引号（单 / 双）内的空白保留，`\"` 与 `\\` 在双引号内转义。 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else if (quote === '"' && ch === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\"))
        cur += text[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote !== undefined) throw bad(text);
  if (has) out.push(cur);
  return out;
}

/** `name=value …`；后给的同名覆盖先给的。 */
export function parseParams(tokens: readonly string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const token of tokens) {
    const at = token.indexOf("=");
    const name = at <= 0 ? "" : token.slice(0, at);
    if (!WORKFLOW_PARAM_PATTERN.test(name)) throw bad(token);
    params[name] = token.slice(at + 1);
  }
  return params;
}

function discover(ctx: CommandContext): WorkflowDiscovery {
  const { runtime } = ctx;
  const cwd = ctx.session().state.cwd;
  return discoverWorkflows(
    workflowSources({
      cwd,
      configDir: runtime.paths.configDir,
      ...(runtime.config.workflows?.dirs !== undefined
        ? { configDirs: runtime.config.workflows.dirs }
        : {}),
    }),
    { trusted: runtime.trust.trusted },
  );
}

function targetsOf(ctx: CommandContext): RoleTargets {
  const providers = ctx.runtime.providers;
  return {
    tiers: ctx.runtime.config.models?.tiers,
    findModel: (ref) => {
      const found = providers.findModel(ref);
      return found.ok ? found.model : undefined;
    },
  };
}

function findFile(found: WorkflowDiscovery, id: string): WorkflowFile {
  const file = found.workflows.find((w) => w.id === id);
  if (file !== undefined) return file;
  const invalid = found.summaries.find((s) => s.id === id && !s.valid);
  if (invalid !== undefined)
    throw new AmaError("invalid_workflow", `Workflow ${id} is invalid: ${invalid.error ?? ""}`);
  throw new AmaError("workflow_not_found", msg().workflows.notFound(id));
}

function hostHandler(ctx: CommandContext): HostWorkflowHandler | undefined {
  for (const handle of [ctx.runtime.host, ...(ctx.runtime.extensions ?? [])]) {
    const handler = handle === undefined ? undefined : hostWorkflowsOf(handle.api);
    if (handler !== undefined) return handler;
  }
  return undefined;
}

/** 本会话单独运行的工作流 id（`/workflow cancel` 的提示用）。 */
const running = new Map<string, string>();

function sessionImpl(ctx: CommandContext): AgentSessionImpl {
  const session = ctx.session();
  if (!(session instanceof AgentSessionImpl))
    throw new AmaError("invalid_arguments", msg().workflows.usage);
  return session;
}

async function runCommand(rest: readonly string[], ctx: CommandContext): Promise<CommandResult> {
  const m = msg().workflows;
  const [id, ...tokens] = rest;
  if (id === undefined) throw new AmaError("invalid_arguments", m.usage);
  const params = parseParams(tokens);
  const file = findFile(discover(ctx), id);
  const session = sessionImpl(ctx);
  const sessionId = session.manager.id;
  if (activeWorkflow(sessionId) !== undefined) return handled([m.run.busy]);
  const resolved = resolveWorkflowParams(file.workflow, params);
  if (!resolved.ok) throw new AmaError(resolved.code, resolved.message);

  const ui = ctx.workflow;
  const prompts = ui === undefined ? undefined : workflowPrompts(ui.choose);
  if (prompts !== undefined) {
    const ok = await prompts.confirm(
      m.preview.title(id),
      previewLines(file.workflow, resolved.params, targetsOf(ctx)),
      m.preview.run,
      m.preview.cancel,
    );
    if (!ok) return { kind: "handled" };
  }

  const config = ctx.runtime.config;
  const seen = new Set<string>();
  const onUpdate = (update: WorkflowUpdate): void => {
    const line = stepProgressLine(update);
    const key = `${update.step?.id}:${update.step?.status}:${update.step?.phase}`;
    if (line === undefined || seen.has(key)) return;
    seen.add(key);
    ui?.notice(line);
  };
  const handler = hostHandler(ctx);
  const handle: WorkflowRunHandle = startWorkflow(workflowHostOf(session), file, {
    params: resolved.params,
    onUpdate,
    ...(prompts === undefined ? {} : { onGate: prompts.gate, onVerifyFailed: prompts.verify }),
    ...(config.workflows?.unattendedGate !== undefined
      ? { unattendedGate: config.workflows.unattendedGate }
      : {}),
    ...(config.limits !== undefined ? { limits: config.limits } : {}),
    ...(handler === undefined ? {} : { hostHandler: handler }),
  });

  if (!handle.host) running.set(sessionId, id);
  const finish = async (): Promise<string[]> => {
    const result = await handle.wait();
    if (running.get(sessionId) === id) running.delete(sessionId);
    if (result.host !== undefined && result.error === undefined)
      return [m.run.handedOff(id, result.host.url ?? result.host.runId)];
    const lines = [m.run.finished(id, statusText(result.status))];
    if (result.error !== undefined) lines.push(result.error.message);
    for (const out of result.outputs) lines.push(out.text);
    return lines;
  };
  if (handle.host || ui === undefined || ui.wait === true) return handled(await finish());
  ui?.notice(m.run.started(id, handle.runId));
  void finish().then(
    (lines) => ui?.notice(lines.join("\n")),
    (error: unknown) => ui?.notice(error instanceof Error ? error.message : String(error), "error"),
  );
  return { kind: "handled" };
}

async function cancelCommand(ctx: CommandContext): Promise<CommandResult> {
  const m = msg().workflows;
  const sessionId = ctx.session().state.sessionId;
  const handle = activeWorkflow(sessionId);
  if (handle === undefined) return handled([m.run.nothingToCancel]);
  const id = running.get(sessionId) ?? handle.runId;
  await handle.cancel();
  return handled([m.run.cancelled(id)]);
}

const two = (n: number): string => String(n).padStart(2, "0");
function defaultSaveId(now: Date): string {
  return `session-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
}

async function saveCommand(rest: readonly string[], ctx: CommandContext): Promise<CommandResult> {
  const m = msg().workflows;
  const user = rest.includes("--user");
  const positional = rest.filter((t) => t !== "--user");
  if (positional.length > 1) throw new AmaError("invalid_arguments", m.usage);
  const session = sessionImpl(ctx);
  const sessionId = session.manager.id;
  const registry = registryOf(sessionId);
  const tasks = registry?.list() ?? [];
  const prompts = new Map<string, string>();
  if (registry !== undefined) {
    const rebuilt = rebuildRecords(session.manager.branch(), registry.catalog, session.cwd);
    for (const [taskId, record] of rebuilt.records)
      if (record.firstPrompt !== undefined) prompts.set(taskId, record.firstPrompt);
  }
  const draft = workflowFromTasks(tasks, prompts, `Workflow from session ${sessionId.slice(0, 8)}`);
  if (draft === undefined) return handled([m.save.nothing]);

  const id = positional[0] ?? defaultSaveId(new Date());
  const scope = user ? "user" : "project";
  const configDir = ctx.runtime.paths.configDir ?? resolveConfigDir();
  const path = resolveWorkflowTarget(
    workflowTargetPath(scope, id, { cwd: session.cwd, configDir }),
  );
  if (existsSync(path)) return handled([m.save.exists(path)]);

  // 写文件不走权限管线：没有能确认的界面就不保存
  if (ctx.workflow === undefined) return handled([m.save.needsUi]);
  const yaml = formatWorkflowFile(draft).split("\n");
  const ok = await workflowPrompts(ctx.workflow.choose).confirm(
    m.save.confirm(path),
    yaml.slice(0, 40),
    m.save.save,
    m.preview.cancel,
  );
  if (!ok) return { kind: "handled" };
  const tool = createWorkflowSaveTool({ configDir: () => configDir });
  const result = await tool.execute({ id, scope, workflow: draft }, {
    cwd: session.cwd,
  } as unknown as ToolContext);
  if (result.isError === true) throw new AmaError("invalid_arguments", String(result.content));
  return handled([m.save.saved(path)]);
}

export async function workflowCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const m = msg().workflows;
  const [sub, ...rest] = tokenize(args);
  switch (sub) {
    case "list":
      return handled(listLines(discover(ctx)));
    case "show": {
      if (rest.length !== 1) throw new AmaError("invalid_arguments", m.usage);
      return handled(showLines(findFile(discover(ctx), rest[0] as string), targetsOf(ctx)));
    }
    case "run":
      return runCommand(rest, ctx);
    case "save":
      return saveCommand(rest, ctx);
    case "cancel":
      return cancelCommand(ctx);
    default:
      return handled([m.usage]);
  }
}
