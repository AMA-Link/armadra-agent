/**
 * [#254] `ama --mode acp --bridge pi` bundle 级：PATH 前面放一个 `pi` 垫片，转到脚本化的假 pi；
 * 用 ama 自己的 ACP 客户端经子进程管道驱动桥，线上消息过官方 schema 校验。
 */

import { spawn } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AcpClient } from "../../src/drivers/acp/client.js";
import type { AcpSessionNotification } from "../../src/drivers/acp/types.js";
import { createLineReader } from "../../src/modes/rpc/jsonl.js";
import { assertAcpWire, type AcpWireLine } from "../helpers/acp-schema.js";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";
import { BUNDLE, hasBundle } from "./spawn.js";

const FAKE = fileURLToPath(new URL("../fixtures/bridge/fake-pi.mjs", import.meta.url));

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

/** `<root>/bin/pi` 垫片（POSIX sh / Windows .cmd）→ 假 pi。 */
function writePiShim(h: TmpHome): string {
  const node = process.execPath;
  if (process.platform === "win32") {
    h.write("bin/pi.cmd", ["@echo off", `"${node}" "${FAKE}" %*`, ""].join("\r\n"));
  } else {
    const path = h.write("bin/pi", ["#!/bin/sh", `exec '${node}' '${FAKE}' "$@"`, ""].join("\n"));
    chmodSync(path, 0o755);
  }
  return h.path("bin");
}

describe.skipIf(!hasBundle)("e2e：ACP 桥（bundle 子进程 + 假 pi）", () => {
  it("initialize → session/new → prompt → 关 stdin 退出 0；命令只有表里的，线上消息过 schema", async () => {
    home = createTmpHome();
    const bin = writePiShim(home);
    const log = home.path("pi.log");
    const child = spawn(process.execPath, [BUNDLE, "--mode", "acp", "--bridge", "pi"], {
      cwd: home.cwd,
      env: {
        ...home.env,
        PATH: `${bin}${delimiter}${home.env["PATH"] ?? process.env["PATH"] ?? ""}`,
        FAKE_PI_LOG: log,
        FAKE_PI_VERSION: "1.5.0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    const wire: AcpWireLine[] = [];
    const tap = (stream: NodeJS.ReadableStream, dir: "in" | "out"): void =>
      void createLineReader(stream, (line) => wire.push({ dir, msg: JSON.parse(line) }));
    tap(child.stdout, "out");
    const toChild = new PassThrough();
    toChild.pipe(child.stdin);
    tap(toChild, "in");
    const updates: AcpSessionNotification[] = [];
    const client = new AcpClient({
      input: child.stdout,
      output: toChild,
      onUpdate: (n) => updates.push(n),
    });
    const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
    await client.initialize();
    const created = await client.newSession(home.cwd);
    expect(created.configOptions?.map((o) => o.id)).toEqual(["model", "thought_level"]);
    const result = await client.prompt(created.sessionId, [{ type: "text", text: "hello" }]);
    expect(result.stopReason).toBe("end_turn");
    const chunk = updates
      .map((n) => n.update)
      .find((u) => u.sessionUpdate === "agent_message_chunk");
    expect(chunk).toMatchObject({ content: { type: "text", text: "echo: hello" } });
    toChild.end();
    expect(await exit).toBe(0);
    assertAcpWire(wire);
    expect(stderr).toBe("");
    const commands = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { type?: string; argv?: string[] });
    expect(commands[0]?.argv?.slice(0, 2)).toEqual(["--mode", "rpc"]);
    expect(commands.flatMap((c) => (c.type !== undefined ? [c.type] : []))).toEqual([
      "get_state",
      "get_available_models",
      "get_available_thinking_levels",
      "get_session_stats",
      "prompt",
      "get_session_stats",
    ]);
  });

  it("pi 低于下限：session/new 答 pi_outdated，不起进程", async () => {
    home = createTmpHome();
    const bin = writePiShim(home);
    const child = spawn(process.execPath, [BUNDLE, "--mode", "acp", "--bridge", "pi"], {
      cwd: home.cwd,
      env: {
        ...home.env,
        PATH: `${bin}${delimiter}${home.env["PATH"] ?? process.env["PATH"] ?? ""}`,
        FAKE_PI_VERSION: "1.0.4",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new AcpClient({ input: child.stdout, output: child.stdin });
    await client.initialize();
    await expect(client.newSession(home.cwd)).rejects.toMatchObject({
      data: { code: "pi_outdated", installed: "1.0.4", minimum: "1.1.0" },
    });
    child.stdin.end();
    await new Promise((resolve) => child.on("close", resolve));
  });
});
