/**
 * [#318] SDK 与 RPC 共用的工作流入口：按目录发现、按 id 取文件、在会话上起跑（设计稿 §4.7）。
 * 模型侧模块，不得 import `src/i18n`。
 */
import { AmaError } from "../errors.js";
import type { AgentSessionImpl } from "../agent/session.js";
import { discoverWorkflows, workflowSources, type WorkflowDiscovery } from "./discover.js";
import type {
  HostWorkflowHandler,
  WorkflowFile,
  WorkflowRunHandle,
  WorkflowRunOptions,
  WorkflowSummary,
} from "./run-types.js";
import { startWorkflow, workflowHostOf } from "./runner.js";
import type { WorkflowDocument } from "./types.js";
import { validateWorkflow } from "./validate.js";

export interface WorkflowLookup {
  cwd: string;
  configDir: string;
  /** 项目级目录需要信任。 */
  trusted: boolean;
  /** config `workflows.dirs`。 */
  dirs?: readonly string[];
}

export function discoverFor(lookup: WorkflowLookup): WorkflowDiscovery {
  return discoverWorkflows(
    workflowSources({
      cwd: lookup.cwd,
      configDir: lookup.configDir,
      ...(lookup.dirs === undefined ? {} : { configDirs: lookup.dirs }),
    }),
    { trusted: lookup.trusted },
  );
}

export function summariesFor(lookup: WorkflowLookup): WorkflowSummary[] {
  return discoverFor(lookup).summaries;
}

/** 按 id 取一个可运行的工作流文件；找不到 / 无效抛 `workflow_not_found` / `invalid_workflow`。 */
export function findWorkflow(id: string, lookup: WorkflowLookup): WorkflowFile {
  const found = discoverFor(lookup);
  const file = found.workflows.find((w) => w.id === id);
  if (file !== undefined) return file;
  const invalid = found.summaries.find((s) => s.id === id && !s.valid);
  if (invalid !== undefined) {
    throw new AmaError("invalid_workflow", `Workflow ${id} is invalid: ${invalid.error ?? ""}`);
  }
  throw new AmaError("workflow_not_found", `No workflow named ${id}.`);
}

/** 内联文档先校验，无效抛 `invalid_workflow`（带全部 issue）。 */
export function checkedDocument(document: unknown): WorkflowDocument {
  const checked = validateWorkflow(document);
  if (checked.ok) return checked.workflow;
  const issues = checked.errors.map((e) => `${e.path}: ${e.message}`);
  throw new AmaError("invalid_workflow", `Workflow is invalid: ${issues[0] ?? ""}`, {
    detail: issues,
  });
}

/** 在会话上起跑（同步抛起跑检查的错误）。内联文档一律单独运行。 */
export function runWorkflowOn(
  session: AgentSessionImpl,
  target: WorkflowFile | { workflow: WorkflowDocument },
  options: WorkflowRunOptions & { hostHandler?: HostWorkflowHandler },
): WorkflowRunHandle {
  return startWorkflow(workflowHostOf(session), target, options);
}
