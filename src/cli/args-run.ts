/**
 * 一次运行的限额与目录类参数：`--max-turns` / `--max-cost` / `--agent-dir` / `--tier`（从 args.ts 拆出）。
 * 解析规则同 args.ts 的 applyValue；用法错误抛 UsageError。
 */

import { TIER_LADDER } from "../agents/tier-ladder.js";
import { msg } from "../i18n/index.js";
import { UsageError, type ParsedArgs } from "./args.js";

export const RUN_VALUE_OPTIONS = ["max-turns", "max-cost", "agent-dir", "tier"] as const;
export type RunValueOption = (typeof RUN_VALUE_OPTIONS)[number];

export function isRunValueOption(name: string): name is RunValueOption {
  return (RUN_VALUE_OPTIONS as readonly string[]).includes(name);
}

export function applyRunValue(args: ParsedArgs, option: RunValueOption, value: string): void {
  switch (option) {
    case "max-turns": {
      const turns = Number(value);
      if (!Number.isInteger(turns) || turns < 1)
        throw new UsageError(msg().cli.args.maxTurnsPositive(value));
      args.maxTurns = turns;
      break;
    }
    case "max-cost": {
      const usd = Number(value);
      if (!Number.isFinite(usd) || usd <= 0)
        throw new UsageError(msg().cli.args.maxCostPositive(value));
      args.maxCostUsd = usd;
      break;
    }
    case "agent-dir":
      (args.agentDirs ??= []).push(value);
      break;
    case "tier":
      if (!(TIER_LADDER as readonly string[]).includes(value))
        throw new UsageError(msg().cli.args.invalidChoice(option, TIER_LADDER, value));
      args.tier = value as (typeof TIER_LADDER)[number];
      break;
  }
}
