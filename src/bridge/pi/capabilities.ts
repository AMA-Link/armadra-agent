/**
 * Pi 版本能力表（#254）：桥只发表里有的 RPC 命令、只开表里起始版本不高于已装版本的可选能力。
 *
 * - 下限 {@link PI_FLOOR}：必需能力里起始版本最晚的一项（`agent_settled.aborted`，1.1.0），低于它拒绝；
 * - 已验证区间 {@link PI_VERIFIED}：区间内按表开关可选能力；高于区间或读不出版本：照跑，按最高已知能力处理，
 *   由调用方给出提示；
 * - 永不发表外命令：旧版 Pi 对未知命令的应答不带 id，请求无从关联（Armadra#710 的根因）。
 */

import { versionSatisfies } from "../../drivers/probe.js";

export const PI_FLOOR = "1.1.0";
export const PI_VERIFIED = ">=1.1.0 <2.0.0";
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** 能力 id → 起始版本（含）。 */
export const PI_CAPABILITY_SINCE = {
  /** `--session-id`：新开与接回都用它。 */
  sessionId: "0.76.0",
  /** `agent_settled` 事件：判定回合结束。 */
  agentSettled: "0.80.4",
  /** `agent_settled.aborted`：判定取消。 */
  settledAborted: "1.1.0",
  /** `get_available_thinking_levels`：thought_level 配置项。 */
  thinkingLevels: "0.81.0",
  /** `prompt` 应答里的 `disposition`：`handled` 时不等回合。 */
  disposition: "0.99.0",
  /** 内置 MCP、`pi.registerMcpServer`、工具 `annotations`。 */
  mcp: "0.99.0",
  /** `get_session_stats` 的 `cost` / `contextUsage`。 */
  sessionStats: "0.63.0",
  /** `Usage.cost.totalFromProvider`：区分账单值与价目表估算。 */
  costFromProvider: "1.5.0",
} as const;

export type PiCapabilityId = keyof typeof PI_CAPABILITY_SINCE;
export type PiCapabilities = Readonly<Record<PiCapabilityId, boolean>>;

/** 桥会发的 RPC 命令 → 起始版本（都不晚于下限，除 thinking 外）。 */
export const PI_COMMAND_SINCE = {
  get_state: "0.76.0",
  get_messages: "0.76.0",
  prompt: "0.76.0",
  steer: "0.76.0",
  abort: "0.76.0",
  set_model: "0.76.0",
  get_available_models: "0.76.0",
  set_thinking_level: "0.76.0",
  get_available_thinking_levels: PI_CAPABILITY_SINCE.thinkingLevels,
  get_session_stats: PI_CAPABILITY_SINCE.sessionStats,
} as const;

export type PiCommandName = keyof typeof PI_COMMAND_SINCE;

/** 版本 → 能力判定的结果。 */
export interface PiVersionInfo {
  /** `unsupported` 低于下限；`verified` 在已验证区间内；`newer` 高于区间；`unknown` 读不出版本。 */
  status: "unsupported" | "verified" | "newer" | "unknown";
  version?: string;
  capabilities: PiCapabilities;
  /** 可发的命令。 */
  commands: ReadonlySet<string>;
}

function atLeast(version: string, since: string): boolean {
  return versionSatisfies(version, `>=${since}`);
}

/** 按版本求能力与可发命令；`undefined`（读不出）与高于区间一样按最高已知能力。 */
export function piVersionInfo(version: string | undefined): PiVersionInfo {
  const known = version !== undefined;
  const has = (since: string): boolean => !known || atLeast(version, since);
  const capabilities = Object.fromEntries(
    (Object.keys(PI_CAPABILITY_SINCE) as PiCapabilityId[]).map((id) => [
      id,
      has(PI_CAPABILITY_SINCE[id]),
    ]),
  ) as Record<PiCapabilityId, boolean>;
  const commands = new Set(
    (Object.keys(PI_COMMAND_SINCE) as PiCommandName[]).filter((c) => has(PI_COMMAND_SINCE[c])),
  );
  const status = !known
    ? "unknown"
    : !atLeast(version, PI_FLOOR)
      ? "unsupported"
      : versionSatisfies(version, PI_VERIFIED)
        ? "verified"
        : "newer";
  return { status, ...(known ? { version } : {}), capabilities, commands };
}
