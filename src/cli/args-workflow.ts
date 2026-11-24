/**
 * `-p --workflow <id>` 与 `--param name=value`（从 args.ts 拆出，设计 §4.7）。
 * 解析规则同 args.ts 的 applyValue；用法错误抛 UsageError。
 */

import { msg } from "../i18n/index.js";
import { WORKFLOW_PARAM_PATTERN } from "../workflows/types.js";
import { UsageError, type ParsedArgs } from "./args.js";

export const WORKFLOW_VALUE_OPTIONS = ["workflow", "param"] as const;
export type WorkflowValueOption = (typeof WORKFLOW_VALUE_OPTIONS)[number];

export function isWorkflowValueOption(name: string): name is WorkflowValueOption {
  return (WORKFLOW_VALUE_OPTIONS as readonly string[]).includes(name);
}

export function applyWorkflowValue(
  args: ParsedArgs,
  option: WorkflowValueOption,
  value: string,
): void {
  if (option === "workflow") {
    args.workflow = value;
    return;
  }
  const eq = value.indexOf("=");
  const name = eq === -1 ? "" : value.slice(0, eq).trim();
  if (!WORKFLOW_PARAM_PATTERN.test(name)) throw new UsageError(msg().cli.args.paramFormat(value));
  const params = (args.workflowParams ??= Object.create(null) as Record<string, string>);
  if (Object.hasOwn(params, name)) throw new UsageError(msg().cli.args.paramDuplicate(name));
  params[name] = value.slice(eq + 1);
}

/** 组合规则：`--workflow` / `--param` 只用于 -p；不接受位置提示与 `-`；`--param` 需要 `--workflow`。 */
export function validateWorkflowArgs(args: ParsedArgs): void {
  const m = msg().cli.args;
  if (args.workflow !== undefined && !args.print) throw new UsageError(m.printOnly("--workflow"));
  if (args.workflowParams !== undefined && args.workflow === undefined)
    throw new UsageError(m.paramNeedsWorkflow);
  if (args.workflow !== undefined && (args.positionals.length > 0 || args.stdin))
    throw new UsageError(m.workflowNoPrompt);
}
