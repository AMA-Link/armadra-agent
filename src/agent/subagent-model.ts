/**
 * 任务的模型 / 档位解析（从 subagent-registry.ts 拆出）：显式 model > 显式 tier（可改派外部 Agent）> 定义自带档。
 * 嵌套任务的发起方是 plan 模式（只读子会话）时档位不能改派外部 Agent（#317 P0-1）。
 */

import type { AgentCatalog } from "../agents/catalog.js";
import { resolveTaskModel, type TaskModelChoice } from "../agents/tiers.js";
import type { NestedSpawner } from "../agents/task-record.js";
import type { PermissionMode } from "../permissions/types.js";
import type { AgentDefinition } from "../agents/types.js";
import type { SubagentRequest } from "../tools/types.js";
import type { SubagentEnvironment } from "./subagent-registry.js";

export function chooseTaskModel(
  from: { catalog: AgentCatalog; env: SubagentEnvironment; hostMode: PermissionMode | undefined },
  agent: AgentDefinition,
  request: SubagentRequest,
  spawner: NestedSpawner | undefined,
  warn: (message: string) => void,
): { agent: AgentDefinition; request: SubagentRequest; model: TaskModelChoice } {
  const { catalog, env } = from;
  const model = resolveTaskModel(
    agent,
    {
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.tier === undefined ? {} : { tier: request.tier }),
      ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
      agentNamed: request.agent !== undefined,
    },
    env.modelConfig ?? {},
    {
      available: (id) => {
        const target = catalog.get(id);
        return (
          target !== undefined && target.runner !== "ama" && env.runners?.(target) !== undefined
        );
      },
      // plan 模式不改派（P0-1）；带 tools 白名单的请求也不改派，外部 runner 不认白名单
      allowRouting:
        (spawner?.permissionMode ?? from.hostMode) !== "plan" && request.tools === undefined,
    },
  );
  if (model.warning !== undefined) warn(`agent ${agent.name}: ${model.warning}`);
  // 改派：换成档位指向的外部 Agent（resolveTaskModel 已确认它可运行）
  const routed = model.agent === undefined ? agent : (catalog.get(model.agent) ?? agent);
  const next =
    model.thinkingLevel !== undefined && model.thinkingLevel !== request.thinkingLevel
      ? { ...request, thinkingLevel: model.thinkingLevel }
      : request;
  return { agent: routed, request: next, model };
}
