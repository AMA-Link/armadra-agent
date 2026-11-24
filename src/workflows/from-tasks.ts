/**
 * [#318] 把本会话深度 1 的子任务整理成工作流草案（多 Agent 工作流设计稿 §4.4、§5.7）。纯函数。
 *
 * 每个任务一个角色与一个 prompt 步骤；`after`：B 依赖所有「`endedAt ≤ B.startedAt`」的任务，再做传递约简。
 * ama 任务的角色 `agentId` 为 `ama`（只读类型 `explore` / `plan` 记 `permissionMode: plan`，其它类型名在
 * description 里列出供人修改），外部任务用 runner id。没有任务时返回 undefined。
 */
import type { TaskInfo } from "../tools/types.js";
import type { PromptStep, WorkflowDocument, WorkflowRole } from "./types.js";
import { WORKFLOW_LIMITS } from "./types.js";

const READ_ONLY_TYPES = new Set(["explore", "plan"]);
const cut = (s: string, max: number): string => [...s].slice(0, max).join("");

export function workflowFromTasks(
  tasks: readonly TaskInfo[],
  prompts: ReadonlyMap<string, string>,
  title: string,
): WorkflowDocument | undefined {
  const top = tasks
    .filter((t) => (t.depth ?? 1) === 1 && t.parentTaskId === undefined)
    .sort((a, b) => a.startedAt - b.startedAt || a.taskId.localeCompare(b.taskId));
  if (top.length === 0) return undefined;

  const dependsOn: number[][] = top.map((b, j) => {
    const deps: number[] = [];
    for (let i = 0; i < j; i++) {
      const end = top[i]!.endedAt;
      if (end !== undefined && end <= b.startedAt) deps.push(i);
    }
    return deps;
  });
  // 传递约简：某依赖若已经是另一个依赖的（传递）前驱就去掉
  const ancestors: Set<number>[] = [];
  for (let j = 0; j < top.length; j++) {
    const set = new Set<number>();
    for (const d of dependsOn[j]!) {
      set.add(d);
      for (const a of ancestors[d]!) set.add(a);
    }
    ancestors.push(set);
  }
  const reduced = dependsOn.map((deps) =>
    deps.filter((d) => !deps.some((o) => o !== d && ancestors[o]!.has(d))),
  );

  const roles: WorkflowRole[] = [];
  const steps: PromptStep[] = [];
  const lost: string[] = [];
  top.forEach((t, i) => {
    const roleId = `role${i + 1}`;
    const isAma = t.runner === "ama";
    if (isAma && t.agent !== "general" && !READ_ONLY_TYPES.has(t.agent))
      lost.push(`${roleId}: ${t.agent}`);
    roles.push({
      id: roleId,
      agentId: isAma ? "ama" : t.runner,
      ...(t.description !== "" ? { title: cut(t.description, 80) } : {}),
      ...(isAma && READ_ONLY_TYPES.has(t.agent) ? { permissionMode: "plan" as const } : {}),
      ...(t.tier !== undefined ? { tier: t.tier } : {}),
    });
    const text = prompts.get(t.taskId)?.trim() || t.description || t.agent;
    const after = reduced[i]!.map((d) => `step${d + 1}`);
    steps.push({
      id: `step${i + 1}`,
      kind: "prompt",
      role: roleId,
      prompt: cut(text, WORKFLOW_LIMITS.prompt),
      ...(after.length > 0 ? { after } : {}),
    });
  });

  return {
    version: 2,
    title: cut(title, WORKFLOW_LIMITS.title),
    ...(lost.length > 0
      ? { description: `Original ama agent types (review and adjust):\n${lost.join("\n")}` }
      : {}),
    roles,
    steps,
  };
}
