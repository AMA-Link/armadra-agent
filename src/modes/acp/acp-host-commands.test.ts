/** ACP 列出与分派扩展斜杠命令（#303）；线上行过官方 schema 校验。 */

import { afterEach, describe, expect, it } from "vitest";
import { assertAcpWire } from "../../../test/helpers/acp-schema.js";
import { commandHost } from "../../../test/helpers/command-host.js";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import { emptyArgs } from "../../cli/args.js";
import { AcpClient } from "../../drivers/acp/client.js";
import type { AcpSessionNotification } from "../../drivers/acp/types.js";
import { memoryTransport } from "../../drivers/test-support.js";
import { runAcpMode } from "./acp-mode.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

async function start(withTemplate = false) {
  h = composeHarness([{ text: "model said" }]);
  if (withTemplate) h.home.write("home/.config/ama/prompts/standup.md", "TEMPLATE $ARGUMENTS");
  const runtime = await h.boot([
    "--mode",
    "rpc",
    "--model",
    "fake/echo",
    "--host",
    commandHost(h.home),
  ]);
  let exit!: Promise<number>;
  const mem = memoryTransport((input, output) => {
    exit = runAcpMode(
      runtime,
      { args: emptyArgs(), prompt: undefined, io: h.io },
      { stdin: input, stdout: output },
    );
    return exit;
  });
  const updates: AcpSessionNotification[] = [];
  const client = new AcpClient({
    input: mem.transport.stdout,
    output: mem.transport.stdin,
    clientInfo: { name: "test", version: "0" },
    onUpdate: (n) => updates.push(n),
  });
  await client.initialize();
  const { sessionId } = await client.newSession(runtime.paths.cwd);
  await new Promise((r) => setTimeout(r, 10));
  const chunks = (): string =>
    updates
      .map((u) => u.update)
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.content.type === "text" ? u.content.text : ""))
      .join("");
  return {
    client,
    sessionId,
    updates,
    chunks,
    async finish() {
      mem.transport.stdin.end();
      await exit;
      await runtime.dispose();
      assertAcpWire(mem.wire);
    },
  };
}

describe("ACP：扩展斜杠命令", () => {
  it("available_commands_update 列出扩展命令（args → input.hint），遮住同名提示模板", async () => {
    const t = await start(true);
    const list = t.updates
      .map((u) => u.update)
      .find((u) => u.sessionUpdate === "available_commands_update");
    const commands =
      list?.sessionUpdate === "available_commands_update" ? list.availableCommands : [];
    expect(commands.filter((c) => c.name === "standup")).toEqual([
      { name: "standup", description: "Summarize", input: { hint: "[day]" } },
    ]);
    expect(commands).toContainEqual({ name: "brief", description: "Brief" });
    await t.finish();
  });

  it("handled：message 作为 agent_message_chunk，end_turn，不开模型回合", async () => {
    const t = await start();
    const result = await t.client.prompt(t.sessionId, [{ type: "text", text: "/standup monday" }]);
    expect(result).toMatchObject({ stopReason: "end_turn", usage: { totalTokens: 0 } });
    expect(t.chunks()).toBe("standup:monday");
    expect(h.fake.calls).toHaveLength(0);
    await t.finish();
  });

  it("handled 没有 message：不发 chunk，end_turn", async () => {
    const t = await start();
    const result = await t.client.prompt(t.sessionId, [{ type: "text", text: "/quiet" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(t.chunks()).toBe("");
    expect(h.fake.calls).toHaveLength(0);
    await t.finish();
  });

  it("prompt：改发 text，走正常模型回合", async () => {
    const t = await start();
    const result = await t.client.prompt(t.sessionId, [{ type: "text", text: "/brief team" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(t.chunks()).toBe("model said");
    expect(h.fake.calls[0]?.context.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Brief for team",
    });
    await t.finish();
  });

  it("未命中：字面文本发给模型；命令抛错：prompt 请求报 internal error", async () => {
    const t = await start();
    await t.client.prompt(t.sessionId, [{ type: "text", text: "/nothing" }]);
    expect(h.fake.calls[0]?.context.messages.at(-1)).toMatchObject({ content: "/nothing" });
    await expect(t.client.prompt(t.sessionId, [{ type: "text", text: "/boom" }])).rejects.toThrow(
      /kaboom/,
    );
    expect(h.fake.calls).toHaveLength(1);
    await t.finish();
  });
});
