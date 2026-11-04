import { describe, expect, it } from "vitest";
import { PI_FLOOR, PI_VERIFIED, piVersionInfo } from "./capabilities.js";

describe("piVersionInfo", () => {
  it("1.0.4 低于下限：unsupported", () => {
    expect(piVersionInfo("1.0.4").status).toBe("unsupported");
    expect(PI_FLOOR).toBe("1.1.0");
  });

  it("1.1.0 是下限：已验证，必需能力齐全；费用不是账单值", () => {
    const info = piVersionInfo("1.1.0");
    expect(info.status).toBe("verified");
    expect(info.capabilities).toMatchObject({
      sessionId: true,
      agentSettled: true,
      settledAborted: true,
      thinkingLevels: true,
      disposition: true,
      mcp: true,
      sessionStats: true,
      costFromProvider: false,
    });
    expect(info.commands.has("get_available_thinking_levels")).toBe(true);
  });

  it("1.4.0 仍无 totalFromProvider，1.5.0 起有", () => {
    expect(piVersionInfo("1.4.0").capabilities.costFromProvider).toBe(false);
    expect(piVersionInfo("1.5.0")).toMatchObject({
      status: "verified",
      capabilities: { costFromProvider: true },
    });
  });

  it("2.0.0 高于区间：newer，按最高已知能力；读不出版本：unknown，同样按最高", () => {
    for (const version of ["2.0.0", undefined]) {
      const info = piVersionInfo(version);
      expect(info.status).toBe(version === undefined ? "unknown" : "newer");
      expect(info.capabilities.costFromProvider).toBe(true);
      expect(info.commands.has("prompt")).toBe(true);
    }
    expect(PI_VERIFIED).toBe(">=1.1.0 <2.0.0");
  });

  it("命令表里没有的命令不在可发集合里", () => {
    const info = piVersionInfo("1.5.0");
    expect(info.commands.has("get_fancy")).toBe(false);
    expect([...info.commands].sort()).toEqual(
      [
        "abort",
        "get_available_models",
        "get_available_thinking_levels",
        "get_messages",
        "get_session_stats",
        "get_state",
        "prompt",
        "set_model",
        "set_thinking_level",
        "steer",
      ].sort(),
    );
  });
});
