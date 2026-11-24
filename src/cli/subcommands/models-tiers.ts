/**
 * `ama models tiers`：按 models.tiers 打印每档的目标、思考档、每 1M 价格与典型任务成本（设计稿 §2.6）。
 * token 单位一律 K / M。
 */

import { TYPICAL_TASK_TOKENS, tierCostRows, type TierCostRow } from "../../agents/tier-cost.js";
import { msg } from "../../i18n/index.js";
import { ExitCode } from "../exit-codes.js";
import type { ModelsAction, ModelsActionContext } from "./models.js";

function tokens(count: number): string {
  if (count >= 1_000_000) return `${+(count / 1_000_000).toFixed(1)}M`;
  return `${+(count / 1000).toFixed(1)}K`;
}

function usd(value: number): string {
  return `$${value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(3)}`;
}

function priceCells(row: TierCostRow): [string, string] {
  const t = msg().subcommands.modelsTiers;
  if (row.kind === "inherit") return ["-", "-"];
  if (
    row.kind === "agent" ||
    row.inputPerM === undefined ||
    row.outputPerM === undefined ||
    row.typicalTaskUsd === undefined
  )
    return [t.priceUnknown, t.priceUnknown];
  return [`${usd(row.inputPerM)} / ${usd(row.outputPerM)}`, `≈ ${usd(row.typicalTaskUsd)}`];
}

export function renderTierRows(rows: readonly TierCostRow[]): string {
  const t = msg().subcommands.modelsTiers;
  const table: string[][] = [[t.colTier, t.colTarget, t.colThinking, t.colPrice, t.colTypical]];
  for (const row of rows) {
    const [price, typical] = priceCells(row);
    const target = row.kind === "agent" ? `${row.target} (${t.external})` : row.target;
    table.push([row.tier, target, row.thinkingLevel ?? "-", price, typical]);
  }
  const widths = table[0]!.map((_, i) => Math.max(...table.map((r) => [...r[i]!].length)));
  const lines = table.map((r) =>
    r
      .map((cell, i) => cell + " ".repeat(widths[i]! - [...cell].length))
      .join("  ")
      .trimEnd(),
  );
  const note = t.note(tokens(TYPICAL_TASK_TOKENS.input), tokens(TYPICAL_TASK_TOKENS.output));
  return `${lines.join("\n")}\n${note}\n`;
}

async function run(ctx: ModelsActionContext): Promise<number> {
  const rows = tierCostRows(ctx.level.merged.config.models?.tiers, (ref) => {
    const found = ctx.registry.findModel(ref);
    return found.ok ? found.model : undefined;
  });
  ctx.io.stdout(renderTierRows(rows));
  return ExitCode.Ok;
}

export const TIERS_ACTION: ModelsAction = {
  usage: "ama models tiers",
  run,
};
