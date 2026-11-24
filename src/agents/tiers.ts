/**
 * [#316] 档位解析（多 Agent 工作流设计稿 §5.2、§2.3）：纯函数，不碰会话与配置读写。
 *
 * ama runner：参数 `model` > 显式 `tier`（回落不限距离，可改派外部 Agent）> 定义 `model` > 定义 `tier`
 * （只接受相邻一档的 `model` 条目）> config `agents.<类型>.model` > 缺省档 standard（同样只相邻一档）>
 * 继承父模型。外部 runner：参数 `model` > 命中档里指向本 Agent 的 `spec.model` > 定义 / config 的 model。
 */

import type { ModelThinkingLevel } from "../ai/types.js";
import { agentEntry } from "../config/types-w5.js";
import type { AgentModelConfig } from "./catalog.js";
import { DEFAULT_TIER, tierSearchOrder } from "./tier-ladder.js";
import type { TierName, TierSpec, TierTable } from "./tier-ladder.js";
import type { AgentDefinition } from "./types.js";

export interface NearestTierOptions {
  accept?: (spec: TierSpec, tier: TierName) => boolean;
  /** 只看距离 ≤ 它的档（定义自带档与缺省档用 1）；缺省不限。 */
  maxDistance?: number;
}

const ORDER: readonly TierName[] = ["light", "standard", "strong", "max"];

export function nearestTier(
  table: TierTable | undefined,
  wanted: TierName,
  options: NearestTierOptions = {},
): { tier: TierName; spec: TierSpec } | undefined {
  if (table === undefined) return undefined;
  const at = ORDER.indexOf(wanted);
  for (const tier of tierSearchOrder(wanted)) {
    if (
      options.maxDistance !== undefined &&
      Math.abs(ORDER.indexOf(tier) - at) > options.maxDistance
    )
      continue;
    const spec = table[tier];
    if (spec === undefined) continue;
    if (options.accept !== undefined && !options.accept(spec, tier)) continue;
    return { tier, spec };
  }
  return undefined;
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
  /** 发起方不是 plan 模式、且请求没带 tools 白名单时为 true；false 时档位不得改派外部 Agent（P0-1）。 */
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

/** 档位条目是 ama 自己的模型（不带外部 Agent）。 */
function isModelEntry(spec: TierSpec): boolean {
  return spec.model !== undefined && spec.agent === undefined;
}

function pick(
  base: TaskModelChoice,
  hit: { tier: TierName; spec: TierSpec },
  thinking: ModelThinkingLevel | undefined,
): TaskModelChoice {
  const out: TaskModelChoice = { ...base, tier: hit.tier };
  if (hit.spec.model !== undefined) out.ref = hit.spec.model;
  if (thinking !== undefined) out.thinkingLevel = thinking;
  return out;
}

export function resolveTaskModel(
  agent: AgentDefinition,
  request: TaskModelRequest,
  config: AgentModelConfig,
  context: TierContext,
): TaskModelChoice {
  const table = config.models?.tiers;
  const requested = request.tier ?? agent.tier;
  const callThinking = request.thinkingLevel;
  const own = agent.model === "inherit" ? undefined : agent.model;
  const configured = agentEntry(config.agents, agent.name)?.model;

  if (agent.runner !== "ama") {
    const out: TaskModelChoice = {};
    if (callThinking !== undefined) out.thinkingLevel = callThinking;
    if (request.model !== undefined) return { ...out, ref: request.model };
    if (requested !== undefined) {
      const hit = nearestTier(table, requested, { accept: (spec) => spec.agent === agent.name });
      if (hit !== undefined) {
        const tiered: TaskModelChoice = { ...out, tier: hit.tier };
        if (hit.spec.model !== undefined) tiered.ref = hit.spec.model;
        return tiered;
      }
    }
    const fallback = own ?? configured;
    return fallback === undefined || fallback === "inherit" ? out : { ...out, ref: fallback };
  }

  // 1. 调用参数 model
  if (request.model !== undefined)
    return callThinking === undefined
      ? { ref: request.model }
      : { ref: request.model, thinkingLevel: callThinking };

  // 2. 显式 tier：回落不限距离，可改派外部 Agent
  let warning: string | undefined;
  if (request.tier !== undefined) {
    const canRoute = (spec: TierSpec): boolean =>
      spec.agent !== undefined &&
      !request.agentNamed &&
      context.allowRouting &&
      context.available(spec.agent);
    const hit = nearestTier(table, request.tier, {
      accept: (spec) => isModelEntry(spec) || canRoute(spec),
    });
    const exact = table?.[request.tier];
    if (exact?.agent !== undefined && !request.agentNamed && hit?.tier !== request.tier)
      warning = `tier ${request.tier}: agent ${exact.agent} is ${
        context.allowRouting ? "not available" : "not allowed (plan mode or a tools allowlist)"
      }; falling back`;
    else if (hit === undefined && table !== undefined && Object.keys(table).length > 0)
      warning = `tier ${request.tier}: no usable entry in models.tiers; using the next source`;
    if (hit !== undefined) {
      const choice = pick({}, hit, callThinking ?? hit.spec.thinkingLevel);
      if (hit.spec.agent !== undefined) choice.agent = hit.spec.agent;
      if (warning !== undefined) choice.warning = warning;
      return choice;
    }
  }

  // 3. 定义的 model
  const withWarning = (choice: TaskModelChoice): TaskModelChoice =>
    warning === undefined ? choice : { ...choice, warning };
  if (own !== undefined)
    return withWarning(
      callThinking === undefined ? { ref: own } : { ref: own, thinkingLevel: callThinking },
    );

  // 4. 定义的 tier：只相邻一档的 model 条目
  if (agent.tier !== undefined) {
    const hit = nearestTier(table, agent.tier, { accept: isModelEntry, maxDistance: 1 });
    if (hit !== undefined)
      return withWarning(
        pick(
          {},
          hit,
          callThinking ?? (agent.thinking === undefined ? hit.spec.thinkingLevel : undefined),
        ),
      );
  }

  // 5. config agents.<类型>.model
  if (configured !== undefined)
    return withWarning(
      configured === "inherit"
        ? callThinking === undefined
          ? {}
          : { thinkingLevel: callThinking }
        : callThinking === undefined
          ? { ref: configured }
          : { ref: configured, thinkingLevel: callThinking },
    );

  // 6. 缺省档
  if (table !== undefined) {
    const hit = nearestTier(table, DEFAULT_TIER, { accept: isModelEntry, maxDistance: 1 });
    if (hit !== undefined)
      return withWarning(pick({}, hit, callThinking ?? hit.spec.thinkingLevel));
  }

  // 7. 继承父模型
  return withWarning(callThinking === undefined ? {} : { thinkingLevel: callThinking });
}
