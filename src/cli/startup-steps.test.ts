import { describe, expect, it, vi } from "vitest";
import type { TierName, TierSpec, TierTable } from "../agents/tier-ladder.js";
import type { AgentSession, EnqueueOptions, PromptOptions } from "../agent/types.js";
import { createDefaultApiRegistry } from "../ai/apis/api.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import type { ProviderRegistryApi } from "../ai/types.js";
import { msg } from "../i18n/index.js";
import { SessionManager } from "../session/manager.js";
import { emptyArgs } from "./args.js";
import { noModelGuidance } from "./default-model.js";
import type { RuntimeDeps } from "./deps.js";
import { defaultSendUser, resolveModel, thinkingOf } from "./startup-steps.js";

// nearestTier 由 M3b 实现；这里按 §5.2 的签名做最小替身（本档优先，其余按档位次序取第一个可接受的）
vi.mock("../agents/tiers.js", () => ({
  nearestTier: (
    table: TierTable | undefined,
    wanted: TierName,
    options?: { accept?: (spec: TierSpec, tier: TierName) => boolean },
  ) => {
    const order: TierName[] = [wanted, "light", "standard", "strong", "max"];
    for (const tier of order) {
      const spec = table?.[tier];
      if (spec !== undefined && (options?.accept?.(spec, tier) ?? true)) return { tier, spec };
    }
    return undefined;
  },
}));

function fakeSession(isStreaming: boolean): {
  session: AgentSession;
  calls: { method: "steer" | "prompt"; text: string; options: unknown }[];
} {
  const calls: { method: "steer" | "prompt"; text: string; options: unknown }[] = [];
  const session = {
    state: { isStreaming },
    async steer(text: string, options?: EnqueueOptions) {
      calls.push({ method: "steer", text, options });
    },
    async prompt(text: string, options?: PromptOptions) {
      calls.push({ method: "prompt", text, options });
      return "started" as const;
    },
  };
  return { session: session as unknown as AgentSession, calls };
}

describe("defaultSendUser：宿主 sendUser 的缺省实现", () => {
  it("运行中：steer 入队并带上 origin", async () => {
    const { session, calls } = fakeSession(true);
    expect(await defaultSendUser(session, "hi", "armadra")).toBe("queued");
    expect(calls).toEqual([{ method: "steer", text: "hi", options: { origin: "armadra" } }]);
  });

  it("空闲：prompt 立即开始，streamingBehavior 为 steer 并带上 origin", async () => {
    const { session, calls } = fakeSession(false);
    expect(await defaultSendUser(session, "hi", "host")).toBe("started");
    expect(calls).toEqual([
      { method: "prompt", text: "hi", options: { streamingBehavior: "steer", origin: "host" } },
    ]);
  });

  it("未给 origin 时不写 origin 键", async () => {
    const { session, calls } = fakeSession(true);
    await defaultSendUser(session, "hi");
    expect(calls[0]?.options).toEqual({});
  });
});

describe("零配置选模型：选择器不列 fake，没有模型时给出引导", () => {
  const registry = () =>
    new ProviderRegistry({
      apis: createDefaultApiRegistry(),
      keys: { env: {}, useEnv: true, userAuthFile: null },
    });

  async function pickWith(env: Record<string, string>) {
    const seen: string[][] = [];
    const reasons: string[] = [];
    const deps = {
      ui: {
        pickModel: async (providers: ProviderRegistryApi, reason: string) => {
          seen.push(providers.list().map((p) => p.id));
          reasons.push(reason);
          return undefined;
        },
      },
    } as unknown as RuntimeDeps;
    const error = await resolveModel(
      emptyArgs(),
      registry(),
      SessionManager.inMemory("/w"),
      undefined,
      deps,
      true,
      env,
    ).catch((e: unknown) => e);
    return { seen, reasons, error: error as Error };
  }

  it("选择器拿到的注册表不含 fake；AMA_SHOW_FAKE=1 时含", async () => {
    const hidden = await pickWith({});
    expect(hidden.seen[0]).not.toContain("fake");
    expect(hidden.seen[0]).toContain("anthropic");
    const shown = await pickWith({ AMA_SHOW_FAKE: "1" });
    expect(shown.seen[0]).toContain("fake");
  });

  it("引导写明环境变量、ama auth set 与 ama providers add", async () => {
    const { reasons, error } = await pickWith({});
    expect(reasons[0]).toContain("ANTHROPIC_API_KEY");
    expect(reasons[0]).toContain("ama auth set <provider>");
    expect(reasons[0]).toContain("ama providers add <id> --base-url <url>");
    expect(error.message).toBe(reasons[0]);
    expect(noModelGuidance(registry())).toBe(reasons[0]);
  });
});

describe("--tier 选模型（#316）", () => {
  const registry = () =>
    new ProviderRegistry({
      apis: createDefaultApiRegistry(),
      keys: { env: { ANTHROPIC_API_KEY: "k" }, useEnv: true, userAuthFile: null },
    });
  const deps = {} as unknown as RuntimeDeps;
  const ref = (() => {
    const p = registry()
      .list()
      .find((x) => x.id === "anthropic");
    const m = registry().findModel(`anthropic/${p?.models?.[0]?.id ?? ""}`);
    return m.ok ? `${m.provider.id}/${m.model.id}` : "";
  })();

  it("命中档位：选其模型与思考档；未命中：stderr 一行并继续走缺省来源", async () => {
    expect(ref).not.toBe("");
    const warns: string[] = [];
    const tiers = { strong: { model: ref, thinkingLevel: "high" as const } };
    const args = { ...emptyArgs(), tier: "strong" as const };
    const hit = await resolveModel(
      args,
      registry(),
      SessionManager.inMemory("/w"),
      undefined,
      deps,
      false,
      {},
      {
        tiers,
        warn: (l) => warns.push(l),
      },
    );
    expect(`${hit.provider.id}/${hit.model.id}`).toBe(ref);
    expect(hit.tierThinking).toBe("high");
    expect(warns).toEqual([]);
    expect(thinkingOf(args, SessionManager.inMemory("/w"), "low", hit.tierThinking)).toBe("high");
    expect(
      thinkingOf({ ...args, model: ref }, SessionManager.inMemory("/w"), "low", hit.tierThinking),
    ).toBe("low");

    const miss = await resolveModel(
      args,
      registry(),
      SessionManager.inMemory("/w"),
      ref,
      deps,
      false,
      {},
      {
        tiers: undefined,
        warn: (l) => warns.push(l),
      },
    );
    expect(`${miss.provider.id}/${miss.model.id}`).toBe(ref);
    expect(miss.tierThinking).toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe(msg().cli.args.tierNotSet("strong", ref));
  });

  it("档位是外部 Agent 条目（agent + model）：不当成 ama 模型，回落并提示，不退出", async () => {
    const warns: string[] = [];
    const tiers = { strong: { agent: "claude", model: "opus" } };
    const args = { ...emptyArgs(), tier: "strong" as const };
    const got = await resolveModel(
      args,
      registry(),
      SessionManager.inMemory("/w"),
      ref,
      deps,
      false,
      {},
      {
        tiers,
        warn: (l) => warns.push(l),
      },
    );
    expect(`${got.provider.id}/${got.model.id}`).toBe(ref);
    expect(got.tierThinking).toBeUndefined();
    expect(warns).toEqual([msg().cli.args.tierNotSet("strong", ref)]);
  });

  it("--model 优先于 --tier，且不提示", async () => {
    const warns: string[] = [];
    const args = { ...emptyArgs(), tier: "max" as const, model: ref };
    const got = await resolveModel(
      args,
      registry(),
      SessionManager.inMemory("/w"),
      undefined,
      deps,
      false,
      {},
      {
        tiers: undefined,
        warn: (l) => warns.push(l),
      },
    );
    expect(`${got.provider.id}/${got.model.id}`).toBe(ref);
    expect(warns).toEqual([]);
  });
});
