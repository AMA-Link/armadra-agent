/**
 * ACP 桥测试的壳（#254）：用 ama 自己的 `AcpClient` 经内存管道驱动 `runBridge`，对端是脚本化的假 Pi；
 * `finish()` 关 stdin、等桥退出，并把每条线上消息过官方 schema 校验。
 */

import { PassThrough } from "node:stream";
import { runBridge } from "../../src/bridge/pi/entry.js";
import { AcpClient, type AcpClientHandlers } from "../../src/drivers/acp/client.js";
import type { AcpSessionNotification } from "../../src/drivers/acp/types.js";
import { createLineReader } from "../../src/modes/rpc/jsonl.js";
import type { WireLine } from "../../src/drivers/test-support.js";
import { assertAcpWire } from "./acp-schema.js";
import { fakePi, type FakePi, type FakePiConfig } from "./fake-pi.js";

export interface BridgeHarness {
  pi: FakePi;
  client: AcpClient;
  updates: AcpSessionNotification[];
  wire: WireLine[];
  stderr: string[];
  /** 桥进程的退出码（`finish()` 之后）。 */
  exit: Promise<number>;
  finish(): Promise<number>;
  updatesOf(kind: string): Record<string, unknown>[];
  /** 所有 pi 实例收到某命令的次数。 */
  commandsOf(type: string): number;
}

export interface HarnessOptions {
  pi?: FakePiConfig;
  argv?: string[];
  handlers?: AcpClientHandlers;
  env?: NodeJS.ProcessEnv;
  /** 缺省真实 PATH 无关：假 Pi 经注入的 probe / spawn 顶替。 */
  noInitialize?: boolean;
}

export async function bridgeHarness(options: HarnessOptions = {}): Promise<BridgeHarness> {
  const pi = fakePi(options.pi);
  const toBridge = new PassThrough();
  const fromBridge = new PassThrough();
  const wire: WireLine[] = [];
  const tap = (stream: PassThrough, dir: "in" | "out"): void => {
    createLineReader(stream, (line) => {
      try {
        wire.push({ dir, msg: JSON.parse(line) as Record<string, unknown> });
      } catch {
        wire.push({ dir, msg: { raw: line } });
      }
    });
  };
  // 客户端写 → 桥读（桥的 in），桥写 → 客户端读（桥的 out）：录制方向取客户端视角
  tap(toBridge, "in");
  tap(fromBridge, "out");
  const stderr: string[] = [];
  const updates: AcpSessionNotification[] = [];
  const exit = runBridge(
    options.argv ?? ["--mode", "acp", "--bridge", "pi"],
    { stderr: (text) => void stderr.push(text), env: options.env ?? { PATH: "/fake" } },
    {
      stdin: toBridge,
      stdout: fromBridge,
      deps: { spawn: pi.spawn, probe: pi.probe, cancelGraceMs: 200, statusWaitMs: 30 },
    },
  );
  const client = new AcpClient({
    input: fromBridge,
    output: toBridge,
    clientInfo: { name: "test", version: "0" },
    onUpdate: (n) => updates.push(n),
    ...options.handlers,
  });
  return {
    pi,
    client,
    updates,
    wire,
    stderr,
    exit,
    commandsOf: (type) => pi.commandNames().filter((n) => n === type).length,
    updatesOf: (kind) =>
      updates
        .map((n) => n.update as unknown as Record<string, unknown>)
        .filter((u) => u["sessionUpdate"] === kind),
    async finish() {
      toBridge.end();
      const code = await exit;
      assertAcpWire(wire);
      return code;
    },
  };
}

export const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));
