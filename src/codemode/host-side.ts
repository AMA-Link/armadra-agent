/**
 * codemode 父进程侧：起子进程、转发工具调用、超时杀树（设计 §5.5 沙箱第 1–4 条）。[B10]
 *
 * - 命令行：`<node> --max-old-space-size=<MB> --permission --allow-fs-read=<入口>
 *   --disallow-code-generation-from-strings <入口> --ama-codemode-sandbox`；堆上限取 `codemode.maxHeapMb`
 *   （缺省 256，0 不加），超出时子进程 OOM 退出，映射为脚本错误（docs/history/memory-plan.md D10）；Node 22.0–22.12 用 `--experimental-permission`。不授予文件写、
 *   子进程、worker、addon、inspector 权限；以空环境启动（拿不到密钥与会话路径）；嵌入 Electron
 *   时设 `ELECTRON_RUN_AS_NODE=1` 运行同一可执行文件。
 * - 入口：bundle 里是 ama.cjs 同目录的 `ama-sandbox.cjs`（构建脚本定义 `__AMA_SANDBOX_ENTRY__`）；
 *   tsc 产物里是同目录的 `sandbox-entry.js`；源码树里是 `sandbox-entry.ts`；取 realpath（权限模型
 *   按真实路径比对，macOS 的 /tmp、/var 是符号链接）。
 * - `tool_call` → `callTool(name, input, signal)`：由 tool.ts 接到 `ToolContext.tools.executeTool`
 *   （完整门禁）；名字是 `codemode` 直接拒绝。脚本结束时 abort 仍在跑的调用。
 * - 超时：父进程计时，到点杀子进程树（POSIX 进程组 / Windows taskkill）；外层 abort：先发
 *   `abort`，宽限后杀树。
 * - 名额：进程内同时存活的子进程数受 `worker-pool.ts` 限制，排队最多 60 s 且计入 `timeout_ms`；名额在子进程
 *   `close` 时归还，不是结果落定时。
 * - OS 沙箱（docs/guides/sandbox.md）：有可用的 sandbox-exec / bwrap / unshare 时，整条命令行经它启动，拒绝
 *   网络与一切写入（`CODEMODE_OS_POLICY`；子进程本来就没有写权限）。Node 22 / 24 的 strict 依赖这一层
 *   （`requireOsSandbox`），包装不了就报错，不裸跑；Node ≥ 25 是叠加的纵深防御。
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { osSandboxStatus, type OsSandboxStatus } from "../sandbox/detect.js";
import type { OsSandboxPolicy } from "../sandbox/profile.js";
import { wrapCommand, type WrappedCommand } from "../sandbox/wrap.js";
import { killProcessTree, trackProcessGroup, untrackProcessGroup } from "../tools/process-tree.js";
import { detectSandboxCapability, type SandboxCapability } from "./capability.js";
import {
  DEFAULT_MAX_WORKERS,
  MAX_WORKER_WAIT_MS,
  codemodeWorkerPool,
  type WorkerPool,
} from "./worker-pool.js";
import {
  LineSplitter,
  SANDBOX_MAIN_FLAG,
  SEARCH_TOOLS_CALL,
  decodeChildLine,
  encodeLine,
  type ParentMessage,
  type ScriptOptions,
  type StoreSnapshot,
  type ToolDecl,
} from "./protocol.js";

declare const __AMA_SANDBOX_ENTRY__: string | undefined;

/** 父进程累积的输出上限（字符）；超出后丢弃中段（给模型的再按 max_output_tokens 截）。 */
export const MAX_COLLECTED_OUTPUT_CHARS = 16 * 1024 * 1024;
/** 外层 abort 后等子进程自行结束的宽限。 */
export const ABORT_GRACE_MS = 500;
/** 子进程 V8 老生代堆上限（MB）缺省值；`codemode.maxHeapMb` 覆盖，0 不设上限。 */
export const DEFAULT_CODEMODE_HEAP_MB = 256;

/** 子进程入口的绝对路径（realpath）；找不到 → undefined。 */
export function resolveSandboxEntry(moduleUrl: string = import.meta.url): string | undefined {
  const here = dirname(fileURLToPath(moduleUrl));
  const candidates: string[] = [];
  if (typeof __AMA_SANDBOX_ENTRY__ !== "undefined")
    candidates.push(join(here, __AMA_SANDBOX_ENTRY__));
  candidates.push(join(here, "sandbox-entry.js"));
  // 源码树（vitest / 开发）：Node ≥ 22.18 直接剥离类型运行 .ts（入口只 import node: 与类型）。
  candidates.push(join(here, "sandbox-entry.ts"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return undefined;
}

/** 子进程参数（不含可执行文件）。V8 选项必须在 `--permission` 与脚本之前。 */
export function sandboxArgs(
  entry: string,
  capability: Pick<SandboxCapability, "permissionFlag"> = detectSandboxCapability(),
  heapMb: number = DEFAULT_CODEMODE_HEAP_MB,
): string[] {
  const heap = Math.floor(heapMb);
  return [
    ...(heap > 0 ? [`--max-old-space-size=${heap}`] : []),
    capability.permissionFlag,
    `--allow-fs-read=${entry}`,
    "--disallow-code-generation-from-strings",
    entry,
    SANDBOX_MAIN_FLAG,
  ];
}

/** codemode 子进程的 OS 沙箱策略：拒绝网络，任何位置都不可写。 */
export const CODEMODE_OS_POLICY: OsSandboxPolicy = Object.freeze({
  network: "deny",
  writable: Object.freeze([]) as readonly string[],
});

/** 完整命令行：`<node> <sandboxArgs>`，有 OS 沙箱时再经它包装。 */
export function sandboxCommand(
  nodePath: string,
  args: readonly string[],
  os: Pick<OsSandboxStatus, "kind" | "path">,
): WrappedCommand {
  return wrapCommand(os, nodePath, args, CODEMODE_OS_POLICY);
}

/** 子进程环境：空；Electron 下以 Node 方式运行同一可执行文件；Windows 保留 SystemRoot。 */
export function sandboxEnv(
  versions: NodeJS.ProcessVersions = process.versions,
  platform: NodeJS.Platform = process.platform,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if ((versions as { electron?: string }).electron !== undefined) env["ELECTRON_RUN_AS_NODE"] = "1";
  if (platform === "win32") {
    const root = parentEnv["SystemRoot"] ?? parentEnv["SYSTEMROOT"];
    if (root !== undefined) env["SystemRoot"] = root;
  }
  return env;
}

export interface SandboxRunRequest {
  script: string;
  options: ScriptOptions;
  tools: ToolDecl[];
  store: StoreSnapshot;
  /** 执行一次内层工具调用：解析为脚本拿到的值，失败抛 Error（消息给脚本）。 */
  callTool(name: string, input: unknown, signal: AbortSignal): Promise<unknown>;
  onOutput?(text: string): void;
  /** 脚本里的 `searchTools(query, options)`；缺省时搜不到任何工具。抛错变成脚本里的 Error。 */
  searchTools?(query: unknown, options: unknown): unknown;
  signal: AbortSignal;
  /** 缺省 resolveSandboxEntry()。 */
  entry?: string;
  /** 缺省 process.execPath。 */
  nodePath?: string;
  capability?: Pick<SandboxCapability, "permissionFlag">;
  /** 缺省 osSandboxStatus()（进程内缓存的探测结果）。 */
  os?: Pick<OsSandboxStatus, "kind" | "path">;
  /** true：必须经 OS 沙箱启动（Node 22 / 24 的 strict 依赖它），包装不了直接失败。 */
  requireOsSandbox?: boolean;
  /** 子进程堆上限（MB），缺省 DEFAULT_CODEMODE_HEAP_MB；0 不设上限。 */
  maxHeapMb?: number;
  /** 进程级沙箱名额池，缺省共享的 `codemodeWorkerPool`；测试注入带假时钟的池。 */
  workerPool?: WorkerPool;
  /** 同时存活的沙箱子进程上限（调用方每次读环境变量 / 配置）；缺省 2。 */
  maxWorkers?: number;
  /** 脚本总超时计时器的注入（测试用手动时钟，不随机器负载漂移）；缺省真实 `setTimeout`。 */
  timeoutTimers?: TimeoutTimers;
}

/** 脚本总超时的计时器（缺省 `setTimeout`）。 */
export interface TimeoutTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimeoutTimers: TimeoutTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 子进程因堆上限 OOM 退出时给模型的文案（固定英文）。 */
export function heapLimitError(heapMb: number): string {
  return `Script exceeded the codemode memory limit (${heapMb} MB); process the data in smaller pieces`;
}

export interface SandboxRunResult {
  ok: boolean;
  error?: string;
  outputs: string[];
  /** 脚本成功且写过 store 时的完整快照。 */
  store?: StoreSnapshot;
  elapsedMs: number;
  timedOut: boolean;
  aborted: boolean;
  /** 内层调用次数。 */
  toolCalls: number;
  /** 输出超过 MAX_COLLECTED_OUTPUT_CHARS 被丢弃的字符数。 */
  droppedChars: number;
  /** 子进程 pid（POSIX 下也是进程组 id）。 */
  pid?: number;
}

export async function runSandbox(request: SandboxRunRequest): Promise<SandboxRunResult> {
  const started = Date.now();
  const entry = request.entry ?? resolveSandboxEntry();
  const heapMb = Math.floor(request.maxHeapMb ?? DEFAULT_CODEMODE_HEAP_MB);
  const base = {
    outputs: [] as string[],
    timedOut: false,
    aborted: false,
    toolCalls: 0,
    droppedChars: 0,
  };
  if (entry === undefined) {
    return {
      ...base,
      ok: false,
      error: "codemode sandbox entry not found (build the package first)",
      elapsedMs: 0,
    };
  }
  if (request.signal.aborted) {
    return { ...base, ok: false, error: "Script aborted", aborted: true, elapsedMs: 0 };
  }
  const command = sandboxCommand(
    request.nodePath ?? process.execPath,
    sandboxArgs(entry, request.capability, heapMb),
    request.os ?? osSandboxStatus(),
  );
  if (request.requireOsSandbox === true && !command.networkDenied) {
    return {
      ...base,
      ok: false,
      error: "codemode sandbox requires an OS sandbox to isolate network, but none is available",
      elapsedMs: 0,
    };
  }
  const timeoutMs = request.options.timeoutMs;
  const pool = request.workerPool ?? codemodeWorkerPool;
  const limit = request.maxWorkers ?? DEFAULT_MAX_WORKERS;
  const slot = await pool.acquire({
    limit,
    waitMs: Math.min(MAX_WORKER_WAIT_MS, timeoutMs),
    signal: request.signal,
  });
  if (slot.status === "aborted") {
    return { ...base, ok: false, error: "Script aborted", aborted: true, elapsedMs: 0 };
  }
  if (slot.status === "timeout") {
    const ownDeadline = timeoutMs <= MAX_WORKER_WAIT_MS;
    return {
      ...base,
      ok: false,
      timedOut: ownDeadline,
      error: ownDeadline
        ? `Script timed out after ${timeoutMs} ms waiting for a free codemode sandbox slot (${slot.active} of ${limit} in use); it was not run`
        : `Script was not run: all ${limit} codemode sandbox slots stayed busy for ${MAX_WORKER_WAIT_MS / 1000} s; try again when other scripts finish`,
      elapsedMs: slot.waitedMs,
    };
  }
  const lease = slot.lease;
  // 等名额的时间计入脚本的 timeout_ms
  const runTimeoutMs = Math.max(1, timeoutMs - slot.waitedMs);
  const isWindows = process.platform === "win32";
  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  try {
    child = spawn(command.command, command.args, {
      env: sandboxEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: !isWindows,
      windowsHide: true,
    });
  } catch (error) {
    lease.release();
    return {
      ...base,
      ok: false,
      error: `Failed to start codemode sandbox: ${(error as Error).message}`,
      elapsedMs: slot.waitedMs,
    };
  }
  const pid = child.pid;
  if (pid !== undefined && !isWindows) trackProcessGroup(pid);

  const calls = new AbortController();
  const result: SandboxRunResult = { ...base, ok: false, elapsedMs: 0 };
  if (pid !== undefined) result.pid = pid;
  let collected = 0;
  let stderr = "";
  let outOfMemory = false;
  let settled = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));

  const write = (message: ParentMessage): void => {
    if (child.stdin.destroyed || !child.stdin.writable) return;
    child.stdin.write(encodeLine(message));
  };
  const kill = (): void => {
    if (pid === undefined) return;
    void killProcessTree(pid, { graceMs: 200 }).finally(() => {
      if (!isWindows) untrackProcessGroup(pid);
    });
  };
  const settle = (patch: Partial<SandboxRunResult>): void => {
    if (settled) return;
    settled = true;
    Object.assign(result, patch);
    result.elapsedMs = patch.elapsedMs ?? Date.now() - started;
    calls.abort();
    finish();
  };

  const timers = request.timeoutTimers ?? realTimeoutTimers;
  const timer = timers.set(() => {
    settle({
      ok: false,
      timedOut: true,
      error: `Script timed out after ${timeoutMs} ms`,
    });
    kill();
  }, runTimeoutMs);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    write({ type: "abort" });
    graceTimer = setTimeout(() => {
      settle({ ok: false, aborted: true, error: "Script aborted" });
      kill();
    }, ABORT_GRACE_MS);
  };
  request.signal.addEventListener("abort", onAbort, { once: true });

  child.stdin.on("error", () => {});
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = stderr + chunk;
    // 原生栈可能把 OOM 那行挤出 4000 字符的尾部：在截断前判定
    if (heapMb > 0 && /heap out of memory/i.test(stderr)) outOfMemory = true;
    stderr = stderr.slice(-4000);
  });
  const splitter = new LineSplitter();
  const onLine = (line: string): void => {
    if (settled) return;
    let message;
    try {
      message = decodeChildLine(line);
    } catch {
      return;
    }
    switch (message.type) {
      case "output": {
        const text = message.text;
        if (collected + text.length > MAX_COLLECTED_OUTPUT_CHARS) {
          result.droppedChars += text.length;
          return;
        }
        collected += text.length;
        result.outputs.push(text);
        request.onOutput?.(text);
        return;
      }
      case "tool_call": {
        const { id, name, input } = message;
        if (name === SEARCH_TOOLS_CALL) {
          const args = (input ?? {}) as { query?: unknown; options?: unknown };
          try {
            const value = request.searchTools?.(args.query, args.options) ?? [];
            write({ type: "tool_result", id, ok: true, value });
          } catch (error) {
            write({
              type: "tool_result",
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }
        result.toolCalls++;
        if (name === "codemode") {
          write({
            type: "tool_result",
            id,
            ok: false,
            error: "codemode cannot be called from a codemode script",
          });
          return;
        }
        request.callTool(name, input, calls.signal).then(
          (value) => {
            if (!settled) write({ type: "tool_result", id, ok: true, value: value ?? null });
          },
          (error: unknown) => {
            if (!settled) {
              write({
                type: "tool_result",
                id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },
        );
        return;
      }
      case "store":
        result.store = message.entries;
        return;
      case "done": {
        const patch: Partial<SandboxRunResult> = { ok: message.ok, elapsedMs: message.elapsedMs };
        if (message.error !== undefined) patch.error = message.error;
        if (request.signal.aborted) {
          patch.ok = false;
          patch.aborted = true;
        }
        if (patch.ok !== true) delete result.store;
        settle(patch);
        return;
      }
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    for (const line of splitter.push(chunk)) onLine(line);
  });
  child.on("error", (error) => {
    settle({ ok: false, error: `Failed to start codemode sandbox: ${error.message}` });
    // 没起来的进程不会再有 close
    if (child.pid === undefined) lease.release();
  });
  child.on("close", (code, signal) => {
    lease.release();
    for (const line of splitter.flush()) onLine(line);
    if (pid !== undefined && !isWindows) untrackProcessGroup(pid);
    if (outOfMemory) {
      settle({ ok: false, error: heapLimitError(heapMb) });
      return;
    }
    const detail = stderr.trim().split("\n").slice(-3).join(" | ");
    settle({
      ok: false,
      error: `codemode sandbox exited unexpectedly (${signal ?? `code ${code}`})${detail === "" ? "" : `: ${detail}`}`,
    });
  });

  write({
    type: "run",
    script: request.script,
    options: request.options,
    tools: request.tools,
    store: request.store,
  });

  await finished;
  timers.clear(timer);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  request.signal.removeEventListener("abort", onAbort);
  if (child.exitCode === null && child.signalCode === null) {
    // 正常结束时子进程会自行退出；兜底：稍后仍在就杀掉。
    const reaper = setTimeout(kill, 1000);
    reaper.unref();
    child.once("close", () => clearTimeout(reaper));
  }
  child.stdin.end();
  return result;
}
