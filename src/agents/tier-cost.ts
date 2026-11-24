/**
 * [#316] 每档的价格提示（多 Agent 工作流设计稿 §5.3、§2.6）。纯函数，不进任何发给模型的文本。
 */

import type { Model } from "../ai/types.js";
import { TIER_LADDER, type TierName, type TierTable } from "./tier-ladder.js";

export const TYPICAL_TASK_TOKENS = { input: 150_000, output: 15_000 } as const;
export interface TierCostRow {
  tier: TierName;
  /** `provider/model`、外部 Agent id，或 `inherit`。 */
  target: string;
  kind: "model" | "agent" | "inherit";
  thinkingLevel?: string;
  inputPerM?: number;
  outputPerM?: number;
  typicalTaskUsd?: number;
}

/** 四档各一行：模型（有价格时带单价与典型任务）、外部 Agent、未配置（inherit）。 */
export function tierCostRows(
  tiers: TierTable | undefined,
  findModel: (ref: string) => Model | undefined,
): TierCostRow[] {
  return TIER_LADDER.map((tier): TierCostRow => {
    const spec = tiers?.[tier];
    const thinking = spec?.thinkingLevel !== undefined ? { thinkingLevel: spec.thinkingLevel } : {};
    if (spec?.agent !== undefined) return { tier, target: spec.agent, kind: "agent", ...thinking };
    if (spec?.model === undefined) return { tier, target: "inherit", kind: "inherit", ...thinking };
    const row: TierCostRow = { tier, target: spec.model, kind: "model", ...thinking };
    const cost = findModel(spec.model)?.cost;
    // 订阅计费等 cost 记 0：不是真实价格，按「价格未知」处理。
    if (cost === undefined || (cost.input === 0 && cost.output === 0)) return row;
    row.inputPerM = cost.input;
    row.outputPerM = cost.output;
    row.typicalTaskUsd =
      (TYPICAL_TASK_TOKENS.input * cost.input + TYPICAL_TASK_TOKENS.output * cost.output) /
      1_000_000;
    return row;
  });
}
