/**
 * [#316] 每档的价格提示（多 Agent 工作流设计稿 §5.3、§2.6）。[M1 桩，M6 实现]
 */

import { AmaError } from "../errors.js";
import type { Model } from "../ai/types.js";
import type { TierName, TierTable } from "./tier-ladder.js";

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
export function tierCostRows(
  _tiers: TierTable | undefined,
  _findModel: (ref: string) => Model | undefined,
): TierCostRow[] {
  throw new AmaError("not_implemented", "tierCostRows is not implemented yet");
}
