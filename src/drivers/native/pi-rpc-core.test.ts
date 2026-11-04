import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AgentTransport } from "../process.js";
import { PiRpcCore, type Json } from "./pi-rpc-core.js";

function setup(commands?: ReadonlySet<string>) {
  const toPi = new PassThrough();
  const fromPi = new PassThrough();
  const written: Json[] = [];
  toPi.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n"))
      if (line !== "") written.push(JSON.parse(line) as Json);
  });
  const transport = {
    stdin: toPi,
    stdout: fromPi,
    stderrTail: () => "boom",
    exited: new Promise<number | null>(() => undefined),
    terminate: async () => undefined,
  } as AgentTransport;
  const events: Json[] = [];
  const ui: Json[] = [];
  const exits: Error[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const core = new PiRpcCore({
    transport,
    ...(commands !== undefined ? { commands } : {}),
    onEvent: (r) => events.push(r),
    onUiRequest: (r) => ui.push(r),
    onExit: (e) => exits.push(e),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return () => undefined;
    },
  });
  const send = (record: Json | string): void => {
    fromPi.write(typeof record === "string" ? record : `${JSON.stringify(record)}\n`);
  };
  return { core, written, events, ui, exits, timers, send, end: () => fromPi.end() };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("PiRpcCore", () => {
  it("按 id 关联应答；事件与扩展 UI 请求原样交给调用方；一条记录可跨块到达", async () => {
    const t = setup();
    const answer = t.core.request({ type: "get_state" });
    await tick();
    expect(t.written[0]).toMatchObject({ id: "ama-1", type: "get_state" });
    t.send({ type: "message_update", text: "a b" });
    t.send({ type: "extension_ui_request", id: "u1", method: "select" });
    // 一条记录拆成两块到达
    const line = JSON.stringify({ id: "ama-1", type: "response", success: true, data: { x: 1 } });
    t.send(line.slice(0, 10));
    await tick();
    t.send(`${line.slice(10)}\n`);
    expect(await answer).toMatchObject({ success: true, data: { x: 1 } });
    expect(t.events).toEqual([{ type: "message_update", text: "a b" }]);
    expect(t.ui).toEqual([{ type: "extension_ui_request", id: "u1", method: "select" }]);
  });

  it("不带 id 的应答无从关联，忽略；非 JSON 行忽略", async () => {
    const t = setup();
    const answer = t.core.request({ type: "get_state" });
    t.send({ type: "response", command: "parse", success: false });
    t.send("not json\n");
    t.send({ id: "ama-1", type: "response", success: true });
    await expect(answer).resolves.toMatchObject({ success: true });
    expect(t.events).toEqual([]);
  });

  it("命令表之外的命令不上线", async () => {
    const t = setup(new Set(["get_state"]));
    await expect(t.core.request({ type: "get_fancy" })).rejects.toMatchObject({
      code: "agent_failed",
    });
    await tick();
    expect(t.written).toEqual([]);
  });

  it("非 prompt 命令有 10 秒截止，prompt 没有", async () => {
    const t = setup();
    const state = t.core.request({ type: "get_state" });
    void t.core.request({ type: "prompt", message: "hi" });
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]?.ms).toBe(10_000);
    t.timers[0]?.fn();
    await expect(state).rejects.toMatchObject({ code: "agent_timeout" });
    // 迟到的应答不影响后续
    t.send({ id: "ama-1", type: "response", success: true });
  });

  it("进程退出：挂起请求以 agent_exited 失败，退出只通知一次，之后的请求直接失败", async () => {
    const t = setup();
    const answer = t.core.request({ type: "get_state" });
    t.end();
    await expect(answer).rejects.toMatchObject({ code: "agent_exited" });
    expect(t.exits).toHaveLength(1);
    expect(t.exits[0]?.message).toContain("boom");
    await expect(t.core.request({ type: "get_state" })).rejects.toMatchObject({
      code: "agent_exited",
    });
    expect(t.core.exited).toBe(true);
  });
});
