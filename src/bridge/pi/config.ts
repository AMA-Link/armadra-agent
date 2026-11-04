/**
 * 桥的会话配置项（#254）：`model` 与 `thought_level` 两个 select。
 *
 * - `model`：值 `provider/id`（`get_available_models`），按供应商分组；当前模型不在列表里时补一项；
 * - `thought_level`：值是 Pi 的级别（`get_available_thinking_levels`，`off`…`max`），是唯一的推理强度控件，
 *   不进 `modes`；当前模型只支持 `off`（不支持推理）时不给这一项。
 */

import type { AcpConfigSelectGroup, AcpSessionConfigOption } from "../../drivers/acp/types.js";
import { msg } from "../../i18n/index.js";
import type { Json } from "./tools.js";

export const CONFIG_IDS = { model: "model", thoughtLevel: "thought_level" } as const;

export interface PiModelRef {
  provider: string;
  id: string;
  name?: string;
}

/** 配置项依赖的 Pi 状态快照。 */
export interface ConfigState {
  models: readonly PiModelRef[];
  current?: PiModelRef;
  /** `get_available_thinking_levels`（读不到为空）。 */
  levels: readonly string[];
  level?: string;
}

export function modelRefOf(value: unknown): PiModelRef | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const m = value as Json;
  if (typeof m["id"] !== "string" || typeof m["provider"] !== "string") return undefined;
  return {
    provider: m["provider"],
    id: m["id"],
    ...(typeof m["name"] === "string" && m["name"] !== "" ? { name: m["name"] } : {}),
  };
}

export const modelValue = (m: PiModelRef): string => `${m.provider}/${m.id}`;

function levelName(level: string): string {
  const names = msg().bridge.config.levels as Record<string, string>;
  return names[level] ?? level;
}

export function buildConfigOptions(state: ConfigState): AcpSessionConfigOption[] {
  const m = msg().bridge.config;
  const options: AcpSessionConfigOption[] = [];
  const models = [...state.models];
  if (
    state.current !== undefined &&
    !models.some((x) => modelValue(x) === modelValue(state.current!))
  )
    models.unshift(state.current);
  if (state.current !== undefined) {
    const groups = new Map<string, AcpConfigSelectGroup>();
    for (const model of models) {
      let group = groups.get(model.provider);
      if (group === undefined) {
        group = { group: model.provider, name: model.provider, options: [] };
        groups.set(model.provider, group);
      }
      group.options.push({ value: modelValue(model), name: model.name ?? model.id });
    }
    options.push({
      id: CONFIG_IDS.model,
      name: m.model,
      category: "model",
      type: "select",
      currentValue: modelValue(state.current),
      options: [...groups.values()],
    });
  }
  const levels = state.levels.filter((l) => l !== "");
  if (levels.some((l) => l !== "off")) {
    options.push({
      id: CONFIG_IDS.thoughtLevel,
      name: m.thoughtLevel,
      category: "thought_level",
      type: "select",
      currentValue:
        state.level !== undefined && levels.includes(state.level)
          ? state.level
          : (levels[0] ?? "off"),
      options: levels.map((level) => ({ value: level, name: levelName(level) })),
    });
  }
  return options;
}
