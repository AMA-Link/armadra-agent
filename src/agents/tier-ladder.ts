/**
 * [#316] 档位阶梯：四档与查找顺序（多 Agent 工作流设计稿 §5.1）。纯数据与纯函数。
 */

import type { ModelThinkingLevel } from "../ai/types.js";

export const TIER_LADDER = ["light", "standard", "strong", "max"] as const;
export type TierName = (typeof TIER_LADDER)[number];
export const DEFAULT_TIER: TierName = "standard";

/** 一档：ama 的模型，或外部 Agent（可带传给它的模型名）。 */
export interface TierSpec {
  model?: string;
  agent?: string;
  thinkingLevel?: ModelThinkingLevel;
}
export type TierTable = Partial<Record<TierName, TierSpec>>;

export function isTierName(value: unknown): value is TierName {
  return typeof value === "string" && (TIER_LADDER as readonly string[]).includes(value);
}

/** wanted、上一档、下一档、上两档、下两档…（越界跳过）；见 §2.3 表。 */
export function tierSearchOrder(wanted: TierName): TierName[] {
  const at = TIER_LADDER.indexOf(wanted);
  const order: TierName[] = [wanted];
  for (let distance = 1; distance < TIER_LADDER.length; distance++) {
    const lower = TIER_LADDER[at - distance];
    const upper = TIER_LADDER[at + distance];
    // 每个距离先取更强的一档，再取更弱的（standard → strong, light, max）。
    if (upper !== undefined) order.push(upper);
    if (lower !== undefined) order.push(lower);
  }
  return order;
}
