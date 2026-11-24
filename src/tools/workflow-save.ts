/**
 * `workflow_save` 工具（多 Agent 工作流设计稿 §4.4）。[#318]
 *
 * 把工作流 v2 JSON 存成 `<cwd>/.ama/workflows/<id>.md`（`scope: "user"` 存 `<configDir>/workflows`）。
 * `annotations.alwaysAsk`：权限管线一律询问（预览含目标路径与 YAML），不进任何工具预设（`+workflow_save` 打开）。
 * 不覆盖已存在的文件（除非 `overwrite: true`）。
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { resolveConfigDir } from "../config/paths.js";
import { workflowTargetPath } from "../workflows/discover.js";
import { formatWorkflowFile } from "../workflows/file.js";
import { validateWorkflow } from "../workflows/validate.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";

export interface WorkflowSaveInput {
  id: string;
  scope?: "project" | "user";
  workflow: unknown;
  overwrite?: boolean;
}

export interface WorkflowSaveToolOptions {
  /** 用户级配置目录（缺省 `resolveConfigDir()`，执行时才解析）。 */
  configDir?: () => string;
}

const DESCRIPTION =
  "Save a multi-agent workflow as .ama/workflows/<id>.md (scope user: the user's config dir) " +
  "after the user approves the preview. workflow is the workflow v2 JSON: version 2, title, " +
  "description?, params[{name,type,label?,default?}], roles[{id,agentId,tier?,model?,worktree?," +
  "permissionMode?,title?}], steps[{id,kind:prompt|collect|gate,role,prompt,after?,from?," +
  "verify?{commands,checklist},maxRetries?,label?}], links?, contract?{text,owns{role:[glob]}}. " +
  "Prompts may use {{param}}.";

const fail = (content: string): ToolResult => ({ content, isError: true });

/**
 * 保存前的符号链接防护：目录链上任何一级是符号链接都拒绝；建好目录后真实路径必须仍在 `root` 之下；
 * 已存在的目标是符号链接也拒绝。返回拒绝原因，通过返回 undefined。
 */
async function checkTarget(root: string, path: string): Promise<string | undefined> {
  const dir = dirname(path);
  let at = root;
  for (const part of relative(root, dir)
    .split(/[\\/]/)
    .filter((p) => p !== "")) {
    at = join(at, part);
    const info = await lstat(at).catch(() => undefined);
    if (info?.isSymbolicLink()) return `${at} is a symbolic link; refusing to save through it.`;
  }
  await mkdir(dir, { recursive: true });
  const realDir = await realpath(dir);
  const expected = join(await realpath(root), relative(root, dir));
  if (realDir !== expected) return `${dir} resolves outside ${root}; refusing to save.`;
  const info = await lstat(path).catch(() => undefined);
  if (info?.isSymbolicLink()) return `${path} is a symbolic link; refusing to write through it.`;
  return undefined;
}

export function createWorkflowSaveTool(
  options: WorkflowSaveToolOptions = {},
): ToolDefinition<WorkflowSaveInput> {
  return {
    name: "workflow_save",
    label: "Save workflow",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        scope: { type: "string", enum: ["project", "user"] },
        workflow: { type: "object" },
        overwrite: { type: "boolean" },
      },
      required: ["id", "workflow"],
      additionalProperties: false,
    },
    permission: "write",
    annotations: { alwaysAsk: true },
    async execute(input: WorkflowSaveInput, ctx: ToolContext): Promise<ToolResult> {
      const scope = input.scope ?? "project";
      if (typeof input.id !== "string") return fail("id must be a string");
      if (scope !== "project" && scope !== "user") return fail('scope must be "project" or "user"');
      const validation = validateWorkflow(input.workflow);
      if (!validation.ok) {
        return fail(
          ["Invalid workflow:", ...validation.errors.map((e) => `${e.path}: ${e.message}`)].join(
            "\n",
          ),
        );
      }
      let path: string;
      try {
        path = workflowTargetPath(scope, input.id, {
          cwd: ctx.cwd,
          configDir: (options.configDir ?? resolveConfigDir)(),
        });
      } catch (error) {
        return fail((error as Error).message);
      }
      const overwrite = input.overwrite === true;
      const root = scope === "user" ? (options.configDir ?? resolveConfigDir)() : ctx.cwd;
      try {
        const refused = await checkTarget(root, path);
        if (refused !== undefined) return fail(refused);
        // "wx" 让「不覆盖」在写入时原子判定；O_NOFOLLOW 让目标是符号链接时写入失败而不是跟随
        const flags =
          constants.O_WRONLY |
          constants.O_CREAT |
          (overwrite ? constants.O_TRUNC : constants.O_EXCL) |
          (constants.O_NOFOLLOW ?? 0);
        const handle = await open(path, flags, 0o644);
        try {
          await handle.writeFile(formatWorkflowFile(validation.workflow), "utf8");
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP")
          return fail(`${path} is a symbolic link; refusing to write through it.`);
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          return fail(`${path} already exists; pass overwrite: true or another id.`);
        return fail(`Could not save workflow: ${(error as Error).message}`);
      }
      return { content: `Saved workflow ${input.id} to ${path}.`, details: { id: input.id, path } };
    },
  };
}
