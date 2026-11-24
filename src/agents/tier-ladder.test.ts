import { describe, expect, it } from "vitest";
import { DEFAULT_TIER, TIER_LADDER, isTierName, tierSearchOrder } from "./tier-ladder.js";

describe("tier-ladder", () => {
  it("四档与缺省档", () => {
    expect(TIER_LADDER).toEqual(["light", "standard", "strong", "max"]);
    expect(DEFAULT_TIER).toBe("standard");
  });

  it("isTierName 只认四档", () => {
    for (const name of TIER_LADDER) expect(isTierName(name)).toBe(true);
    for (const value of ["fast", "Light", "", undefined, null, 1])
      expect(isTierName(value)).toBe(false);
  });

  it("tierSearchOrder 与 §2.3 表一致", () => {
    expect(tierSearchOrder("light")).toEqual(["light", "standard", "strong", "max"]);
    expect(tierSearchOrder("standard")).toEqual(["standard", "strong", "light", "max"]);
    expect(tierSearchOrder("strong")).toEqual(["strong", "max", "standard", "light"]);
    expect(tierSearchOrder("max")).toEqual(["max", "strong", "standard", "light"]);
  });
});
