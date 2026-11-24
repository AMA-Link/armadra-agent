/**
 * [#318] 工作流目录发现与保存路径（多 Agent 工作流设计稿 §4.4、§5.7）。
 *
 * 顺序：config `workflows.dirs` → `<configDir>/workflows`（用户级）→ `<cwd>/.ama/workflows`（项目级，需信任；
 * 未信任跳过并记入 `skippedUntrusted`）。每个来源目录只看直接下层的 `*.md`（按名排序）；id = 文件名；
 * 同 id 先发现者胜并 warning。无效文件进 `summaries`（`valid: false` + `error`），不进 `workflows`。
 * 同步实现，需要时现发现，不缓存。
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AmaError } from "../errors.js";
import { parseWorkflowFile } from "./file.js";
import type { WorkflowFile, WorkflowScope, WorkflowSummary } from "./run-types.js";
import { WORKFLOW_ID_PATTERN } from "./types.js";

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

const WORKFLOWS_DIR = "workflows";

export function userWorkflowDir(configDir: string): string {
  return join(configDir, WORKFLOWS_DIR);
}

export function workflowSources(o: {
  cwd: string;
  configDir: string;
  configDirs?: readonly string[];
}): WorkflowDirSource[] {
  const out: WorkflowDirSource[] = [];
  for (const dir of o.configDirs ?? [])
    out.push({ dir: resolve(o.cwd, dir), scope: "config", requiresTrust: false });
  out.push({ dir: userWorkflowDir(o.configDir), scope: "user", requiresTrust: false });
  out.push({ dir: join(o.cwd, ".ama", WORKFLOWS_DIR), scope: "project", requiresTrust: true });
  return out;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function markdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function workflowFileHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function discoverWorkflows(
  sources: readonly WorkflowDirSource[],
  o: { trusted: boolean },
): WorkflowDiscovery {
  const result: WorkflowDiscovery = {
    workflows: [],
    summaries: [],
    warnings: [],
    skippedUntrusted: [],
  };
  const byId = new Map<string, string>();
  const seenDirs = new Set<string>();
  for (const source of sources) {
    if (seenDirs.has(source.dir)) continue;
    seenDirs.add(source.dir);
    if (!isDir(source.dir)) continue;
    if (source.requiresTrust && !o.trusted) {
      result.skippedUntrusted.push(source.dir);
      continue;
    }
    for (const name of markdownFiles(source.dir)) {
      const filePath = join(source.dir, name);
      const id = name.slice(0, -".md".length);
      const first = byId.get(id);
      if (first !== undefined) {
        result.warnings.push(`${filePath}: workflow "${id}" already defined at ${first}; ignored`);
        continue;
      }
      byId.set(id, filePath);
      const invalid = (error: string): void => {
        result.summaries.push({ id, scope: source.scope, filePath, valid: false, error });
      };
      let text: string;
      try {
        text = readFileSync(filePath, "utf8");
      } catch (error) {
        invalid((error as Error).message);
        continue;
      }
      if (!WORKFLOW_ID_PATTERN.test(id)) {
        invalid(`invalid workflow id "${id}" (file name)`);
        continue;
      }
      const parsed = parseWorkflowFile(text);
      const workflow = parsed.workflow;
      if (workflow === undefined) {
        invalid(
          parsed.issues
            .filter((i) => i.severity === "error")
            .map((i) => `${i.path}: ${i.message}`)
            .join("; "),
        );
        continue;
      }
      for (const issue of parsed.issues)
        result.warnings.push(`${filePath}: ${issue.path}: ${issue.message}`);
      result.workflows.push({
        id,
        scope: source.scope,
        filePath,
        workflow,
        hash: workflowFileHash(text),
      });
      result.summaries.push({
        id,
        scope: source.scope,
        filePath,
        title: workflow.title,
        roles: workflow.roles.length,
        steps: workflow.steps.length,
        ...(workflow.params !== undefined && workflow.params !== null
          ? { params: workflow.params }
          : {}),
        valid: true,
      });
    }
  }
  return result;
}

export function workflowTargetPath(
  scope: "project" | "user",
  id: string,
  paths: { cwd: string; configDir: string },
): string {
  if (!WORKFLOW_ID_PATTERN.test(id)) {
    throw new AmaError("invalid_workflow_id", `Invalid workflow id "${id}"`);
  }
  const dir =
    scope === "user" ? userWorkflowDir(paths.configDir) : join(paths.cwd, ".ama", WORKFLOWS_DIR);
  return join(dir, `${id}.md`);
}

/**
 * 解析后的保存路径（预览显示用）：取最近的已存在祖先的真实路径，再接上还不存在的部分；
 * 目标或其目录是符号链接时，用户看到的是真正会被写到的地方。
 */
export function resolveWorkflowTarget(path: string): string {
  const rest: string[] = [];
  let at = path;
  while (!existsSync(at) && dirname(at) !== at) {
    rest.unshift(at.slice(dirname(at).length + 1));
    at = dirname(at);
  }
  try {
    return join(realpathSync(at), ...rest);
  } catch {
    return path;
  }
}
