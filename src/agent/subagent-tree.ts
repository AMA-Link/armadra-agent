/**
 * 嵌套派发的子会话侧（多 Agent 工作流设计稿 §3.1–§3.2）：取根注册表、发起方的 `NestedSpawner`。[#317]
 * 注册表侧规则在 subagent-nest.ts。
 */

import type { NestedSpawner } from "../agents/task-record.js";
import { chargeSpend } from "./limits.js";
import type { SessionCore } from "./session-core.js";
import type { AgentSessionOptions } from "./session-core.js";
import {
  registryOf,
  subagentRegistryFor,
  type RegistryHost,
  type SubagentRegistry,
} from "./subagent-registry.js";

type TreeParent = RegistryHost & { readonly options: AgentSessionOptions };

/** 根会话的注册表：根会话自己（懒建）或嵌套子会话经 `nested.rootSessionId` 找到；根已关闭时 undefined。 */
export function rootRegistryOf(parent: TreeParent): SubagentRegistry | undefined {
  const nested = parent.options.nested;
  return nested === undefined ? subagentRegistryFor(parent) : registryOf(nested.rootSessionId);
}

/**
 * 发起嵌套任务的子会话。`permissionMode` 现取（只读子会话的管线 `mode` 恒为 `plan`），记录交给外部 /
 * 宿主 runner 的模式据此得出，不取根会话；`charge` 把后代花费记进本会话的预算。
 */
export function nestedSpawner(parent: TreeParent): NestedSpawner {
  return {
    get permissionMode() {
      return parent.options.permission?.mode ?? "default";
    },
    charge: (usd) => chargeSpend(parent as unknown as SessionCore, usd),
  };
}
