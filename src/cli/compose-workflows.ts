/**
 * [#318] 工作流会话扩展（多 Agent 工作流设计稿 §5.7）：根会话装配；resume 时把未结束的运行
 * 重建为 interrupted，dispose 时取消在跑的运行。[M1 桩，M12 实现；注册那一行由 M7b 加进 compose-extensions.ts]
 */

import type { SessionExtensionFactory } from "../agent/session-extensions.js";
import type { ComposeExtensionDeps } from "./compose-extensions.js";

export function createWorkflowsFactory(_deps: ComposeExtensionDeps): SessionExtensionFactory {
  return () => undefined;
}
