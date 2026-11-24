/**
 * [#316] 档位解析（多 Agent 工作流设计稿 §5.2、§2.3）。[M1 桩，M3b 实现]
 */

import { AmaError } from "../errors.js";
import type { ModelThinkingLevel } from "../ai/types.js";
import type { AgentModelConfig } from "./catalog.js";
import type { TierName, TierSpec, TierTable } from "./tier-ladder.js";
import type { AgentDefinition } from "./types.js";

export interface NearestTierOptions {
  accept?: (spec: TierSpec, tier: TierName) => boolean;
  /** 只看距离 ≤ 它的档（定义自带档与缺省档用 1）；缺省不限。 */
  maxDistance?: number;
}
export function nearestTier(
  _table: TierTable | undefined,
  _wanted: TierName,
  _options?: NearestTierOptions,
): { tier: TierName; spec: TierSpec } | undefined {
  throw new AmaError("not_implemented", "nearestTier is not implemented yet");
}

export interface TaskModelRequest {
  model?: string;
  /** 调用方显式给的档。 */
  tier?: TierName;
  thinkingLevel?: ModelThinkingLevel;
  /** 调用显式给了 agent（档位条目不再改派）。 */
  agentNamed: boolean;
}
export interface TierContext {
  /** 目录里有、且当前可运行的外部 Agent。 */
  available(agentName: string): boolean;
  /** 发起方不是 plan 模式时为 true；false 时档位不得改派外部 Agent（P0-1）。 */
  allowRouting: boolean;
}
export interface TaskModelChoice {
  /** 改派到的外部 Agent（只在 request 没给 agent 且 allowRouting 时）。 */
  agent?: string;
  /** `provider/model[@channel]`，或外部 Agent 的模型名；undefined = 继承 / 外部缺省。 */
  ref?: string;
  thinkingLevel?: ModelThinkingLevel;
  /** 实际命中的档（回落后）。 */
  tier?: TierName;
  warning?: string;
}
export function resolveTaskModel(
  _agent: AgentDefinition,
  _request: TaskModelRequest,
  _config: AgentModelConfig,
  _context: TierContext,
): TaskModelChoice {
  throw new AmaError("not_implemented", "resolveTaskModel is not implemented yet");
}
