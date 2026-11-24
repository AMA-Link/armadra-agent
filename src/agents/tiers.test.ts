import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "./builtin.js";
import { nearestTier, resolveTaskModel, type TierContext } from "./tiers.js";
import type { TierTable } from "./tier-ladder.js";
import type { AgentDefinition } from "./types.js";

const base = BUILTIN_AGENTS[0]!;
const def = (extra: Partial<AgentDefinition> = {}): AgentDefinition => ({ ...base, ...extra });
const ctx = (extra: Partial<TierContext> = {}): TierContext => ({
  available: (name) => name === "claude" || name === "codex",
  allowRouting: true,
  ...extra,
});
const full: TierTable = {
  light: { model: "p/light", thinkingLevel: "off" },
  standard: { model: "p/std", thinkingLevel: "low" },
  strong: { agent: "claude", model: "opus" },
  max: { agent: "codex", model: "gpt-x", thinkingLevel: "high" },
};
const config = (tiers?: TierTable, agents?: object) =>
  ({ models: { tiers }, ...(agents ? { agents } : {}) }) as never;
const call = { agentNamed: false };

describe("nearestTier", () => {
  it("按 tierSearchOrder 回落；maxDistance 限制距离；accept 过滤", () => {
    const table: TierTable = { max: { model: "p/max" } };
    expect(nearestTier(table, "light")?.tier).toBe("max");
    expect(nearestTier(table, "light", { maxDistance: 1 })).toBeUndefined();
    expect(nearestTier(table, "strong", { maxDistance: 1 })?.tier).toBe("max");
    expect(nearestTier(table, "max", { accept: () => false })).toBeUndefined();
    expect(nearestTier(undefined, "max")).toBeUndefined();
    expect(nearestTier({ light: { model: "a" }, max: { model: "b" } }, "standard")?.tier).toBe(
      "light",
    );
  });
});

describe("resolveTaskModel：ama runner", () => {
  it("model 参数最优先，tier 被忽略", () => {
    const r = resolveTaskModel(
      def(),
      { ...call, model: "p/x", tier: "strong" },
      config(full),
      ctx(),
    );
    expect(r).toEqual({ ref: "p/x" });
  });

  it("显式 tier 命中 model 条目：写入档与思考档；调用的思考档优先", () => {
    expect(resolveTaskModel(def(), { ...call, tier: "light" }, config(full), ctx())).toEqual({
      ref: "p/light",
      tier: "light",
      thinkingLevel: "off",
    });
    expect(
      resolveTaskModel(
        def(),
        { ...call, tier: "light", thinkingLevel: "high" },
        config(full),
        ctx(),
      ).thinkingLevel,
    ).toBe("high");
  });

  it("显式 tier 命中 agent 条目：改派，ref 是外部模型名", () => {
    expect(resolveTaskModel(def(), { ...call, tier: "max" }, config(full), ctx())).toEqual({
      agent: "codex",
      ref: "gpt-x",
      tier: "max",
      thinkingLevel: "high",
    });
  });

  it("显式 agent、plan 模式、不可用：不改派，按表回落并警告", () => {
    const named = resolveTaskModel(def(), { agentNamed: true, tier: "max" }, config(full), ctx());
    expect(named).toMatchObject({ ref: "p/std", tier: "standard" });
    expect(named.warning).toBeUndefined();
    const plan = resolveTaskModel(
      def(),
      { ...call, tier: "max" },
      config(full),
      ctx({ allowRouting: false }),
    );
    expect(plan).toMatchObject({ ref: "p/std", tier: "standard" });
    expect(plan.agent).toBeUndefined();
    expect(plan.warning).toMatch(/plan mode/);
    const down = resolveTaskModel(
      def(),
      { ...call, tier: "max" },
      config(full),
      ctx({ available: () => false }),
    );
    expect(down.agent).toBeUndefined();
    expect(down.warning).toMatch(/not available/);
  });

  it("显式 tier 全表回落不限距离", () => {
    const only: TierTable = { max: { model: "p/max" } };
    expect(resolveTaskModel(def(), { ...call, tier: "light" }, config(only), ctx())).toMatchObject({
      ref: "p/max",
      tier: "max",
    });
  });

  it("表非空但无可用条目：警告并继承", () => {
    const r = resolveTaskModel(
      def(),
      { ...call, tier: "light" },
      config({ max: { agent: "codex" } }),
      ctx({ allowRouting: false }),
    );
    expect(r.ref).toBeUndefined();
    expect(r.warning).toBeDefined();
  });

  it("定义 model > 定义 tier（相邻一档）> agents.<类型>.model > 缺省档（相邻一档）> 继承", () => {
    expect(
      resolveTaskModel(def({ model: "p/own", tier: "light" }), call, config(full), ctx()).ref,
    ).toBe("p/own");
    const tiered = resolveTaskModel(def({ tier: "light" }), call, config(full), ctx());
    expect(tiered).toMatchObject({ ref: "p/light", tier: "light", thinkingLevel: "off" });
    // 定义自带档只接受相邻一档：light 的邻居是 standard
    expect(
      resolveTaskModel(def({ tier: "light" }), call, config({ max: { model: "p/max" } }), ctx())
        .ref,
    ).toBeUndefined();
    expect(
      resolveTaskModel(def({ tier: "light" }), call, config({ standard: { model: "p/s" } }), ctx()),
    ).toMatchObject({ ref: "p/s", tier: "standard" });
    // 定义写了 thinking 时不取档位的思考档
    expect(
      resolveTaskModel(def({ tier: "light", thinking: "high" }), call, config(full), ctx())
        .thinkingLevel,
    ).toBeUndefined();
    // 定义自带档不改派
    expect(
      resolveTaskModel(def({ tier: "max" }), call, config({ max: { agent: "codex" } }), ctx())
        .agent,
    ).toBeUndefined();
    const cfg = config(full, { general: { model: "p/cfg" } });
    expect(resolveTaskModel(def(), call, cfg, ctx()).ref).toBe("p/cfg");
    expect(resolveTaskModel(def(), call, config(full), ctx())).toMatchObject({
      ref: "p/std",
      tier: "standard",
      thinkingLevel: "low",
    });
    expect(
      resolveTaskModel(def(), call, config({ strong: { model: "p/st" } }), ctx()),
    ).toMatchObject({ ref: "p/st", tier: "strong" });
    expect(
      resolveTaskModel(def(), call, config({ max: { model: "p/m" } }), ctx()).ref,
    ).toBeUndefined();
    expect(resolveTaskModel(def(), call, config(undefined), ctx())).toEqual({});
  });

  it("explore 走 light；没配档位时继承", () => {
    const explore = BUILTIN_AGENTS[1]!;
    expect(resolveTaskModel(explore, call, config(full), ctx())).toMatchObject({
      ref: "p/light",
      tier: "light",
    });
    expect(resolveTaskModel(explore, call, config(undefined), ctx())).toEqual({});
  });
});

describe("resolveTaskModel：外部 runner", () => {
  const claude = def({ name: "claude", runner: "claude" });
  it("model 参数 > 同名档位的 spec.model > agents.<id>.model > 不给", () => {
    expect(resolveTaskModel(claude, { ...call, model: "m" }, config(full), ctx()).ref).toBe("m");
    expect(
      resolveTaskModel(claude, { agentNamed: true, tier: "strong" }, config(full), ctx()),
    ).toMatchObject({ ref: "opus", tier: "strong" });
    // 档位指向别的 Agent：不作用
    expect(
      resolveTaskModel(claude, { agentNamed: true, tier: "max" }, config(full), ctx()).ref,
    ).toBe("opus");
    expect(
      resolveTaskModel(
        claude,
        { agentNamed: true },
        config({ light: { model: "p/l" } }, { claude: { model: "c" } }),
        ctx(),
      ).ref,
    ).toBe("c");
    expect(resolveTaskModel(claude, { agentNamed: true }, config(undefined), ctx())).toEqual({});
  });
});
