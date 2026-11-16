/** `-p` 分派扩展斜杠命令（#303）：handled / prompt / 未命中 / 抛错，三种输出格式。 */

import { afterEach, describe, expect, it } from "vitest";
import { commandHost } from "../../../test/helpers/command-host.js";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

function boot(script = [{ text: "model said" }]): string[] {
  h = composeHarness(script);
  return ["--host", commandHost(h.home), "--model", "fake/echo"];
}

describe("print 模式：扩展斜杠命令", () => {
  it("handled：text 格式把 message 写到 stdout，退出 0，不调模型", async () => {
    const base = boot();
    expect(await h.run(["-p", "/standup monday", ...base])).toBe(0);
    expect(h.stdout()).toBe("standup:monday\n");
    expect(h.fake.calls).toHaveLength(0);
    expect(h.stderr()).toBe("");
  });

  it("handled：json 给 result 对象（text = message，零用量，不带更早的助手消息）", async () => {
    const base = boot();
    expect(await h.run(["-p", "/standup x", "--output-format", "json", ...base])).toBe(0);
    const result = JSON.parse(h.stdout()) as Record<string, unknown>;
    expect(result).toMatchObject({
      type: "result",
      stopReason: "stop",
      text: "standup:x",
      usage: { input: 0, output: 0 },
    });
    expect(h.fake.calls).toHaveLength(0);
  });

  it("handled：stream-json 只有一行 result 对象（没有会话事件）", async () => {
    const base = boot();
    expect(await h.run(["-p", "/standup y", "--output-format", "stream-json", ...base])).toBe(0);
    const lines = h.stdout().trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "result", text: "standup:y" });
  });

  it("handled 没有 message：stdout 为空，退出 0", async () => {
    const base = boot();
    expect(await h.run(["-p", "/quiet", ...base])).toBe(0);
    expect(h.stdout()).toBe("");
    expect(h.fake.calls).toHaveLength(0);
  });

  it("prompt：改发 text 给模型，输出是模型回复", async () => {
    const base = boot();
    expect(await h.run(["-p", "/brief the team", ...base])).toBe(0);
    expect(h.stdout()).toBe("model said\n");
    expect(h.fake.calls).toHaveLength(1);
    expect(h.fake.calls[0]?.context.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Brief for the team",
    });
  });

  it("未命中：字面文本照常发给模型", async () => {
    const base = boot();
    expect(await h.run(["-p", "/nothing here", ...base])).toBe(0);
    expect(h.fake.calls[0]?.context.messages.at(-1)).toMatchObject({
      role: "user",
      content: "/nothing here",
    });
  });

  it("扩展命令遮住同名提示模板", async () => {
    const base = boot();
    h.home.write("home/.config/ama/prompts/standup.md", "TEMPLATE $ARGUMENTS");
    expect(await h.run(["-p", "/standup z", ...base])).toBe(0);
    expect(h.stdout()).toBe("standup:z\n");
    expect(h.fake.calls).toHaveLength(0);
  });

  it("命令抛错：stderr 一行，退出 1，stdout 为空，不调模型", async () => {
    const base = boot();
    expect(await h.run(["-p", "/boom", ...base])).toBe(1);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toContain("kaboom");
    expect(h.fake.calls).toHaveLength(0);
  });
});
