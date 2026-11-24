import { describe, expect, it } from "vitest";
import type { Model } from "../ai/types.js";
import { TYPICAL_TASK_TOKENS, tierCostRows } from "./tier-cost.js";

const priced = { cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } } as Model;
const free = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model;
const bare = {} as Model;
const find = (ref: string): Model | undefined =>
  ({ "a/priced": priced, "a/free": free, "a/bare": bare })[ref];

describe("tierCostRows", () => {
  it("四档各一行：有价格、无价格、外部 Agent、未配置", () => {
    const rows = tierCostRows(
      {
        light: { model: "a/bare" },
        standard: { model: "a/priced", thinkingLevel: "high" },
        strong: { agent: "claude-code" },
      },
      find,
    );
    expect(rows.map((r) => r.tier)).toEqual(["light", "standard", "strong", "max"]);
    expect(rows[0]).toEqual({ tier: "light", target: "a/bare", kind: "model" });
    expect(rows[1]).toMatchObject({
      kind: "model",
      thinkingLevel: "high",
      inputPerM: 3,
      outputPerM: 15,
    });
    const expected = (TYPICAL_TASK_TOKENS.input * 3 + TYPICAL_TASK_TOKENS.output * 15) / 1_000_000;
    expect(rows[1]!.typicalTaskUsd).toBeCloseTo(expected);
    expect(rows[2]).toEqual({ tier: "strong", target: "claude-code", kind: "agent" });
    expect(rows[3]).toEqual({ tier: "max", target: "inherit", kind: "inherit" });
  });

  it("cost 为 0 或模型找不到：价格未知", () => {
    const rows = tierCostRows({ light: { model: "a/free" }, max: { model: "x/none" } }, find);
    expect(rows[0]!.typicalTaskUsd).toBeUndefined();
    expect(rows[3]).toEqual({ tier: "max", target: "x/none", kind: "model" });
  });

  it("tiers 未设：全部 inherit", () => {
    expect(tierCostRows(undefined, find).every((r) => r.kind === "inherit")).toBe(true);
  });
});
