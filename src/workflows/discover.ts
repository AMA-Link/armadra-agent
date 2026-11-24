/** [#318] 工作流目录发现与保存路径（§5.7、§4.4）。[M1 桩，M10 实现] */
import { AmaError } from "../errors.js";
import type { WorkflowFile, WorkflowScope, WorkflowSummary } from "./run-types.js";

export interface WorkflowDirSource {
  dir: string;
  scope: WorkflowScope;
  requiresTrust: boolean;
}
export interface WorkflowDiscovery {
  workflows: WorkflowFile[];
  summaries: WorkflowSummary[];
  warnings: string[];
  skippedUntrusted: string[];
}

export function userWorkflowDir(_configDir: string): string {
  throw new AmaError("not_implemented", "userWorkflowDir is not implemented yet");
}

export function workflowSources(_o: {
  cwd: string;
  configDir: string;
  configDirs?: readonly string[];
}): WorkflowDirSource[] {
  throw new AmaError("not_implemented", "workflowSources is not implemented yet");
}

export function discoverWorkflows(
  _sources: readonly WorkflowDirSource[],
  _o: { trusted: boolean },
): WorkflowDiscovery {
  throw new AmaError("not_implemented", "discoverWorkflows is not implemented yet");
}

export function workflowTargetPath(
  _scope: "project" | "user",
  _id: string,
  _paths: { cwd: string; configDir: string },
): string {
  throw new AmaError("not_implemented", "workflowTargetPath is not implemented yet");
}

export function workflowFileHash(_text: string): string {
  throw new AmaError("not_implemented", "workflowFileHash is not implemented yet");
}
