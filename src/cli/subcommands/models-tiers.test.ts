import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import { setLocale } from "../../i18n/index.js";
import { buildProviderRegistry } from "../compose-providers.js";
import type { CliIo } from "../deps.js";
import { defaultIo } from "../main.js";
import { runModels } from "./models.js";

let home: TmpHome;
let out: string[];

beforeEach(() => {
  home = createTmpHome();
  out = [];
});
afterEach(() => {
  home.cleanup();
  setLocale("zh");
});

function io(): CliIo {
  return {
    ...defaultIo(),
    stdout: (t: string) => void out.push(t),
    stderr: () => undefined,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env: { ...home.env, RELAY_KEY: "sk-relay", AMA_NO_LOCAL_PROBE: "1" },
    cwd: home.cwd,
  };
}
const deps = {
  providers: {
    create: (input: Parameters<typeof buildProviderRegistry>[0]) =>
      buildProviderRegistry(input, { env: io().env, includeFake: false, probeLocal: false }),
  },
};

describe("ama models tiers", () => {
  it("四种行与 K/M 单位", async () => {
    writeFileSync(
      join(home.configDir, "config.json"),
      JSON.stringify({
        version: 1,
        providers: {
          relay: {
            baseUrl: "https://relay.example/v1",
            apiKey: "$RELAY_KEY",
            models: [{ id: "priced", cost: { input: 3, output: 15 } }, { id: "bare" }],
          },
        },
        models: {
          tiers: {
            light: { model: "relay/bare" },
            standard: { model: "relay/priced", thinkingLevel: "high" },
            strong: { agent: "claude-code" },
          },
        },
      }),
    );
    expect(await runModels(["tiers"], io(), deps)).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/light\s+relay\/bare\s+-\s+价格未知/);
    expect(text).toMatch(/standard\s+relay\/priced\s+high\s+\$3\.00 \/ \$15\.00\s+≈ \$0\.675/);
    expect(text).toMatch(/strong\s+claude-code \(外部 Agent\)\s+-\s+价格未知/);
    expect(text).toMatch(/max\s+inherit/);
    expect(text).toContain("150K 输入 + 15K 输出");
    expect(text).not.toMatch(/万/);
  });
});
