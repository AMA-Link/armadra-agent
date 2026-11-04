import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError } from "../../cli/args.js";
import { main } from "../../cli/main.js";
import { setLocale } from "../../i18n/index.js";
import { bridgeLangOf, hasBridgeFlag, parseBridgeArgs } from "./args.js";

beforeEach(() => setLocale("en"));
afterEach(() => setLocale("zh"));

describe("parseBridgeArgs", () => {
  it("--bridge pi 配 --mode acp；-- 之后原样交给 pi", () => {
    expect(parseBridgeArgs(["--mode", "acp", "--bridge", "pi"])).toEqual({
      bridge: "pi",
      passthrough: [],
    });
    expect(
      parseBridgeArgs([
        "--bridge=pi",
        "--mode=acp",
        "--lang",
        "en",
        "--",
        "--skill",
        "/s/a",
        "--append-system-prompt",
        "be brief",
        "-e",
        "/x/ext.ts",
        "--model=fakeco/alpha",
      ]),
    ).toEqual({
      bridge: "pi",
      lang: "en",
      passthrough: [
        "--skill",
        "/s/a",
        "--append-system-prompt",
        "be brief",
        "-e",
        "/x/ext.ts",
        "--model=fakeco/alpha",
      ],
    });
  });

  it("只认 pi，且必须配 --mode acp；别的选项报用法错误", () => {
    expect(() => parseBridgeArgs(["--mode", "acp", "--bridge", "codex"])).toThrow(UsageError);
    expect(() => parseBridgeArgs(["--bridge", "pi"])).toThrow(/requires --mode acp/);
    expect(() => parseBridgeArgs(["--mode", "rpc", "--bridge", "pi"])).toThrow(
      /requires --mode acp/,
    );
    expect(() => parseBridgeArgs(["--mode", "acp", "--bridge", "pi", "--model", "x"])).toThrow(
      /unknown option --model/,
    );
    expect(() => parseBridgeArgs(["--mode", "acp", "--bridge"])).toThrow(/needs a value/);
  });

  it.each([
    "--mode",
    "--mode=rpc",
    "--session",
    "--session-id=abc",
    "--session-dir",
    "-c",
    "--continue",
    "-r",
    "--resume",
    "--fork",
    "--no-session",
    "--tools",
    "--tools=read",
    "-t",
    "--no-mcp",
    "-p",
    "--print",
  ])("桥自己管的旗标 %s 不能透传", (flag) => {
    expect(() =>
      parseBridgeArgs(["--mode", "acp", "--bridge", "pi", "--", "--skill", "/s", flag, "x"]),
    ).toThrow(/managed by the bridge/);
  });

  it("hasBridgeFlag 只看 -- 之前；bridgeLangOf 宽松预扫", () => {
    expect(hasBridgeFlag(["--mode", "acp", "--bridge", "pi"])).toBe(true);
    expect(hasBridgeFlag(["--bridge=pi"])).toBe(true);
    expect(hasBridgeFlag(["--mode", "acp", "--", "--bridge", "pi"])).toBe(false);
    expect(hasBridgeFlag(["--mode", "acp"])).toBe(false);
    expect(bridgeLangOf(["--lang=zh", "--bridge", "pi"])).toBe("zh");
    expect(bridgeLangOf(["--lang", "fr", "--bridge", "pi"])).toBeUndefined();
  });
});

describe("main 的 --bridge 分流", () => {
  const run = async (argv: string[]) => {
    const err: string[] = [];
    const code = await main(argv, {
      processHooks: false,
      io: { stderr: (t) => void err.push(t), env: { AMA_LANG: "en" } },
    });
    return { code, err: err.join("") };
  };

  it("用法错误退出码 2，不进 bootstrap（不要求 key 与模型）", async () => {
    const bad = await run(["--bridge", "pi"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("--bridge pi requires --mode acp");
    const owned = await run(["--mode", "acp", "--bridge", "pi", "--", "--tools", "read"]);
    expect(owned.code).toBe(2);
    expect(owned.err).toContain("--tools is managed by the bridge");
  });
});
