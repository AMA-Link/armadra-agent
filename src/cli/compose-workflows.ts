/**
 * [#318] 工作流会话扩展（多 Agent 工作流设计稿 §5.7）：根会话装配；resume 时把未结束的运行
 * 重建为 interrupted，dispose 时取消在跑的运行。
 */

import type { SessionExtensionFactory } from "../agent/session-extensions.js";
import { registryOf } from "../agent/subagent-registry.js";
import { WORKFLOW_CUSTOM_TYPE } from "../workflows/run-types.js";
import { interruptedRecordOf, rebuildWorkflowRuns } from "../workflows/record.js";
import { activeWorkflow, bindWorkflowAgents } from "../workflows/runner.js";
import type { ComposeExtensionDeps } from "./compose-extensions.js";

export function createWorkflowsFactory(deps: ComposeExtensionDeps): SessionExtensionFactory {
  return ({ core }) => {
    if (core.depth > 0) return undefined;
    const sessionId = core.manager.id;

    // 起跑检查：用会话任务注册表的目录与 runner 判断 Agent 是否真可用（`general` / `ama` 总可用）
    bindWorkflowAgents(sessionId, (name) => {
      if (name === "ama" || name === "general") return true;
      const registry = registryOf(sessionId);
      const agent = registry?.catalog.get(name);
      if (agent === undefined) return false;
      return agent.runner === "ama" || registry?.env.runners?.(agent) !== undefined;
    });

    // resume：上一轮没结束的运行追加终态快照（不自动续跑）
    try {
      for (const record of rebuildWorkflowRuns(core.manager.branch())) {
        // 工厂在会话构造中途调用：直接写 manager，不发 entry_appended
        core.manager.append({
          type: "custom",
          customType: WORKFLOW_CUSTOM_TYPE,
          data: interruptedRecordOf(record, Date.now()),
        });
      }
    } catch (error) {
      core.log("warn", `workflow resume rebuild failed: ${String(error)}`);
    }

    return {
      id: "ama.workflows",
      dispose() {
        bindWorkflowAgents(sessionId, undefined);
        const handle = activeWorkflow(sessionId);
        if (handle !== undefined) void handle.cancel().catch(() => undefined);
      },
    };
  };
}
