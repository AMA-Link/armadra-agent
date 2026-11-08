/**
 * `bash` 工具（设计 §5.2、§4.2）。[B3]
 *
 * - `spawn(shell, args, { detached: !win, stdio: [ignore, pipe, pipe] })`，stdout / stderr 合流；
 * - 超时（缺省 120 s，上限 600 s）与 abort 都走 `killProcessTree`：SIGTERM → 2 s → SIGKILL；
 * - 滚动尾部节流后经 `ctx.onUpdate` 流出；超限（2000 行 / 50 KB 与会话结果上限减余量取小）尾截断并落全文；
 * - 结构化结果 `{ output, exit_code, truncated, full_output_path?, wall_time_seconds }`；
 *   信号退出 `128 + signo`；非零退出码 → isError；
 * - 注入 `AMA_*` 环境变量（shell.ts）。shell 退出后不等仍占着管道的后台进程。
 * - [W5-H2] 后台命令（§8.3 H6，不加新工具）：`{ command, background: true }` 立即返回
 *   `{ jobId, outputPath, pid }`；`{ job, action: "wait" | "output" | "stop" | "extend" }` 查询 / 结束 / 续命
 *   （bash-jobs.ts + background-jobs.ts，按会话登记，会话 dispose 时回收进程树；退出经提醒通道通知）。
 * - [#266] 前台命令运行超过 `autoBackgroundAfterMs`（0 关）仍未结束时**原地转后台**：不重启进程，清掉超时计时器、
 *   解绑 abort、停止流式更新，把已累积输出落盘为任务输出文件，交给后台任务表登记（`adopt`），工具立即返回
 *   `{ jobId, outputPath, movedToBackground: true, output }`；之后受 [#267] 寿命上限约束（从转换时刻起算），
 *   原来的 120 / 600 s 超时不再生效。阈值 ≥ 超时时超时先到，照旧杀掉、不转。
 * - **进程只在 `spawnShell` 里创建**（前台与后台共用）。[S2] `sandbox.bash: auto` 且有能限制写入的
 *   OS 沙箱时在这一处包一层（src/sandbox/bash.ts）；`sandbox: false` 不包装（权限管线照常审批）。
 *   失败输出像是被沙箱拒绝时末尾追加一行说明。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { resolvePath } from "./paths.js";
import { buildShellArgs, buildToolEnv, resolveShell, type ShellConfig } from "./shell.js";
import {
  exitCodeOf,
  isGroupAlive,
  killProcessTree,
  trackProcessGroup,
  untrackProcessGroup,
  type ProcessDeps,
} from "./process-tree.js";
import { OutputAccumulator } from "./output-accumulator.js";
import {
  DEFAULT_MAX_LINES,
  formatSize,
  resolveOutputDir,
  safeFileName,
  toolOutputBytes,
} from "./truncate.js";
import type { BackgroundJobs, Job } from "./background-jobs.js";
import {
  backgroundMaxMs,
  fail,
  jobAction,
  jobsOf,
  movedResult,
  startBackground,
} from "./bash-jobs.js";
import { REAL_TIMERS, type TimeoutTimers } from "./timers.js";
import {
  looksLikeSandboxDenial,
  runsSandboxed,
  sandboxDenialHint,
  wrapBashCommand,
  type BashCallPlace,
  type BashSandbox,
} from "../sandbox/bash.js";

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;
const UPDATE_THROTTLE_MS = 100;
/** shell 退出后等管道关闭的上限（后台子进程可能一直占着）。 */
const STDIO_DRAIN_MS = 200;

export { DEFAULT_BASH_AUTO_BACKGROUND_MS, DEFAULT_BASH_BACKGROUND_MAX_MS } from "./bash-jobs.js";

export interface BashInput {
  /** 前台 / 后台命令；查询后台任务时不给。 */
  command?: string;
  /** 前台：超时；`wait`：等待时长；[#267] `extend`：续命增量（缺省与上限相同）。 */
  timeoutMs?: number;
  cwd?: string;
  description?: string;
  /** [W5-H2] 后台运行：立即返回 jobId。 */
  background?: boolean;
  /** [W5-H2] 后台任务 id（与 action 一起用）。 */
  job?: string;
  action?: "wait" | "output" | "stop" | "extend";
  /** [S2] false：不经 OS 沙箱运行（走正常审批）。只在沙箱生效时出现在 schema 里。 */
  sandbox?: boolean;
}

/** [W5-H2] `wait` 的缺省等待（毫秒）。 */
export const DEFAULT_JOB_WAIT_MS = 30_000;

export interface BackgroundStart {
  jobId: string;
  outputPath: string;
  pid?: number;
  /** [S2] 经 OS 沙箱运行。 */
  sandboxed?: true;
}

export interface BashStructured {
  output: string;
  exit_code: number;
  truncated: boolean;
  full_output_path?: string;
  wall_time_seconds: number;
  /** [S2] 经 OS 沙箱运行。 */
  sandboxed?: true;
}

export interface BashDetails extends BashStructured {
  timedOut: boolean;
  aborted: boolean;
  killedWithSigkill: boolean;
  totalLines: number;
  totalBytes: number;
  cwd: string;
  description?: string;
}

export interface BashToolOptions {
  /** config.tools.bashTimeoutMs；缺省 120 000。 */
  defaultTimeoutMs?: number;
  /**
   * [#266] config.tools.bashAutoBackgroundAfterMs（组装根按运行模式定缺省）：前台命令运行超过该毫秒数
   * 原地转后台；0 / 不设关闭。
   */
  autoBackgroundAfterMs?: number;
  /** [#267] config.tools.bashBackgroundMaxMs：后台任务寿命上限；缺省 2 小时，0 不限。 */
  backgroundMaxMs?: number;
  /** [#266 / #267] 阈值与寿命计时器（测试注入手动时钟）；缺省真实 setTimeout。 */
  timers?: TimeoutTimers;
  /** [#242] `{job, action:"wait"}` 的等待上限（`coordinator` 预设下组装根给 5 s）；缺省 `MAX_BASH_TIMEOUT_MS`。 */
  waitCapMs?: number;
  /** 测试注入：固定 shell 选择。 */
  shell?(): ShellConfig;
  /** 测试注入：杀树参数（宽限时间等）。 */
  processDeps?: ProcessDeps;
  /** 测试注入：基础环境，缺省 process.env。 */
  baseEnv?(): NodeJS.ProcessEnv;
  /** 测试注入：会话的后台任务表，缺省按会话 id 登记（background-jobs.ts）。 */
  jobs?(sessionId: string): BackgroundJobs;
  /** [S2] bash 的 OS 沙箱设定（组装时算一次，会话内不变）；缺省不用沙箱。 */
  sandbox?: BashSandbox;
}

export interface SpawnShellOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** POSIX 自成进程组（杀树用）；Windows 为 false。 */
  detached: boolean;
  /** 前台 `["ignore", "pipe", "pipe"]`；后台把输出文件描述符直接交给子进程。 */
  stdio: ["ignore", "pipe" | number, "pipe" | number];
  /** [S2] 经 OS 沙箱运行：设定与这次调用的位置（工作区、输出目录）。 */
  sandbox?: { settings: BashSandbox; place: BashCallPlace };
}

/**
 * bash 工具唯一的进程创建点（前台 / 后台共用）；[S2] 给了 `sandbox` 时经 OS 沙箱包装（包不上抛错，
 * 不悄悄裸跑）。
 */
export function spawnShell(
  shell: ShellConfig,
  command: string,
  options: SpawnShellOptions,
): ChildProcess {
  const args = buildShellArgs(shell, command);
  const wrapped =
    options.sandbox === undefined
      ? { command: shell.shell, args }
      : wrapBashCommand(options.sandbox.settings, shell.shell, args, options.sandbox.place);
  return spawn(wrapped.command, wrapped.args, {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: options.stdio,
    windowsHide: true,
  });
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** 等 shell 退出；之后最多再等 STDIO_DRAIN_MS 让管道读完，再强制关闭。 */
function waitForExit(child: ChildProcess): Promise<ExitInfo> {
  return new Promise((resolve, reject) => {
    let exit: ExitInfo | undefined;
    let settled = false;
    const done = () => {
      if (settled || exit === undefined) return;
      settled = true;
      resolve(exit);
    };
    child.once("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.once("close", (code, signal) => {
      exit ??= { code, signal };
      done();
    });
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        done();
      }, STDIO_DRAIN_MS).unref();
    });
  });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function executeBash(
  input: BashInput,
  ctx: ToolContext,
  options: BashToolOptions = {},
): Promise<ToolResult> {
  if (input.job !== undefined)
    return jobAction(input, ctx, options, MAX_BASH_TIMEOUT_MS, DEFAULT_JOB_WAIT_MS);
  if (input.action !== undefined) return fail("action needs job (a background job id)");
  if (typeof input.command !== "string" || input.command.trim() === "") {
    return fail("command must be a non-empty string");
  }
  const command = input.command;
  const timeoutMs = input.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_BASH_TIMEOUT_MS) {
    return fail(`timeoutMs must be between 1 and ${MAX_BASH_TIMEOUT_MS}`);
  }
  const cwd = resolvePath(input.cwd ?? ".", ctx.cwd);
  try {
    if (!(await stat(cwd)).isDirectory())
      return fail(`Working directory is not a directory: ${cwd}`);
  } catch {
    return fail(`Working directory does not exist: ${cwd}`);
  }
  if (ctx.signal.aborted) return fail("aborted by user");

  const shell = options.shell ? options.shell() : resolveShell();
  const env = buildToolEnv(options.baseEnv ? options.baseEnv() : process.env, {
    sessionId: ctx.sessionId,
    sessionFile: ctx.sessionFile,
    provider: ctx.model?.provider,
    model: ctx.model?.id,
    thinkingLevel: ctx.thinkingLevel,
    depth: ctx.depth,
  });
  const isWindows = (options.processDeps?.platform ?? process.platform) === "win32";
  const sandbox =
    options.sandbox !== undefined && runsSandboxed(options.sandbox, input)
      ? {
          settings: options.sandbox,
          place: {
            workspace: ctx.cwd,
            outputDir: resolveOutputDir(ctx.outputDir),
          } satisfies BashCallPlace,
        }
      : undefined;
  if (input.background === true)
    return startBackground(
      command,
      (fd) =>
        spawnShell(shell, command, {
          cwd,
          env,
          detached: !isWindows,
          stdio: ["ignore", fd, fd],
          ...(sandbox === undefined ? {} : { sandbox }),
        }),
      shell.shell,
      cwd,
      sandbox !== undefined,
      ctx,
      options,
    );
  const started = Date.now();
  const acc = new OutputAccumulator({
    maxBytes: toolOutputBytes(ctx.maxResultChars),
    spillPath: () =>
      join(resolveOutputDir(ctx.outputDir), safeFileName(`bash-${ctx.toolCallId}.log`)),
  });

  let child: ChildProcess;
  try {
    child = spawnShell(shell, command, {
      cwd,
      env,
      detached: !isWindows,
      stdio: ["ignore", "pipe", "pipe"],
      ...(sandbox === undefined ? {} : { sandbox }),
    });
  } catch (err) {
    return fail(`Failed to start shell ${shell.shell}: ${(err as Error).message}`);
  }
  const pid = child.pid;
  if (pid !== undefined && !isWindows) trackProcessGroup(pid);

  let moved = false;
  let lastUpdate = 0;
  let pendingUpdate: NodeJS.Timeout | undefined;
  const emitUpdate = () => {
    pendingUpdate = undefined;
    lastUpdate = Date.now();
    ctx.onUpdate(acc.tail());
  };
  const onData = (chunk: Buffer) => {
    acc.append(chunk);
    if (moved || pendingUpdate) return;
    const wait = Math.max(0, lastUpdate + UPDATE_THROTTLE_MS - Date.now());
    pendingUpdate = setTimeout(emitUpdate, wait);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  let timedOut = false;
  let aborted = false;
  let killing: Promise<boolean> | undefined;
  const kill = () => {
    if (pid === undefined) return;
    killing ??= killProcessTree(pid, options.processDeps);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const onAbort = () => {
    aborted = true;
    kill();
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  // [#266] 阈值到了仍在跑 → 原地转后台（已退出的不转：让正常路径收尾）
  const timers = options.timers ?? REAL_TIMERS;
  const afterMs = options.autoBackgroundAfterMs ?? 0;
  let resolveMoved: ((result: ToolResult) => void) | undefined;
  const movedPromise = new Promise<ToolResult>((resolve) => {
    resolveMoved = resolve;
  });
  const moveTimer =
    afterMs > 0
      ? timers.set(() => {
          if (moved || hasExited(child) || timedOut || aborted) return;
          // 先落盘、登记，成功后才解绑前台的超时与 abort：persist / adopt 抛错（磁盘满、目录不可写）时命令
          // 留在前台照常受超时约束，不能让异常逃出计时器回调（会成为 uncaughtException）
          let job: Job;
          try {
            const outputPath = acc.persist();
            job = jobsOf(ctx, options).adopt(command, {
              cwd,
              outputPath,
              child,
              startedAt: started,
              maxMs: backgroundMaxMs(options),
              ...(options.processDeps === undefined ? {} : { processDeps: options.processDeps }),
              ...(options.timers === undefined ? {} : { timers: options.timers }),
            });
          } catch (err) {
            ctx.log(
              "warn",
              `bash: could not move the command to the background, keeping it in the foreground: ${(err as Error).message}`,
            );
            return;
          }
          moved = true;
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
          if (pendingUpdate) {
            clearTimeout(pendingUpdate);
            pendingUpdate = undefined;
          }
          resolveMoved?.(
            movedResult(job, acc.tail(DEFAULT_MAX_LINES), afterMs, sandbox !== undefined, command),
          );
        }, afterMs)
      : undefined;

  const exited = waitForExit(child);
  // 转后台后这个 promise 没人等了：出错不能变成 unhandled rejection
  exited.catch(() => undefined);
  let exit: ExitInfo;
  try {
    const outcome = await Promise.race([
      exited.then((info) => ({ kind: "exit" as const, info })),
      movedPromise.then((result) => ({ kind: "moved" as const, result })),
    ]);
    if (outcome.kind === "moved") return outcome.result;
    exit = outcome.info;
  } catch (err) {
    return fail(`Failed to run command with ${shell.shell}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    if (moveTimer !== undefined) timers.clear(moveTimer);
    ctx.signal.removeEventListener("abort", onAbort);
    if (pendingUpdate) {
      // 冲掉节流中的最后一次更新，保证 UI 看到的尾部是完整的。
      clearTimeout(pendingUpdate);
      emitUpdate();
    }
  }
  const killedWithSigkill = killing ? await killing : false;
  // 后台子进程仍在组里时保持登记，进程退出时一并清理。
  if (pid !== undefined && !isWindows && !isGroupAlive(pid)) untrackProcessGroup(pid);

  const out = acc.finish();
  const exitCode = exitCodeOf(exit.code, exit.signal);
  const wall = Math.round((Date.now() - started) / 10) / 100;
  const structured: BashStructured = {
    output: out.output,
    exit_code: exitCode,
    truncated: out.truncated,
    ...(out.fullOutputPath !== undefined ? { full_output_path: out.fullOutputPath } : {}),
    wall_time_seconds: wall,
    ...(sandbox === undefined ? {} : { sandboxed: true as const }),
  };
  const details: BashDetails = {
    ...structured,
    timedOut,
    aborted,
    killedWithSigkill,
    totalLines: out.totalLines,
    totalBytes: out.totalBytes,
    cwd,
    ...(input.description !== undefined ? { description: input.description } : {}),
  };

  const parts: string[] = [out.output === "" ? "(no output)" : out.output];
  if (out.truncated) {
    const where = out.fullOutputPath ? ` Full output: ${out.fullOutputPath}` : "";
    parts.push(
      `[Output truncated: showing the last ${out.outputLines} of ${out.totalLines} lines ` +
        `(${formatSize(out.totalBytes)} total).${where}]`,
    );
  }
  if (aborted) parts.push("aborted by user");
  else if (timedOut) parts.push(`[Command timed out after ${timeoutMs} ms and was killed]`);
  if (exitCode !== 0) parts.push(`[exit code: ${exitCode}]`);
  const networkDenied = sandbox?.settings.network === "deny";
  if (sandbox !== undefined && exitCode !== 0 && !aborted && !timedOut)
    if (looksLikeSandboxDenial(out.output, networkDenied))
      parts.push(sandboxDenialHint(networkDenied));
  return {
    content: parts.join("\n\n"),
    isError: exitCode !== 0 || timedOut || aborted,
    structured,
    details,
  };
}

/** [S2] 沙箱生效时追加到描述末尾的一句（会话内不变）。 */
export function sandboxDescription(sandbox: BashSandbox | undefined): string {
  if (sandbox?.active !== true) return "";
  const net = sandbox.network === "deny" ? ", no network" : "";
  return ` Runs in an OS sandbox (writes only in workspace/temp${net}); sandbox:false needs approval.`;
}

export function createBashTool(options: BashToolOptions = {}): ToolDefinition<BashInput> {
  const sandboxed = options.sandbox?.active === true;
  return {
    name: "bash",
    label: "Bash",
    description:
      "Run a shell command; stdout+stderr combined, keeps the tail (full output saved to a " +
      `file). Timeout ${DEFAULT_BASH_TIMEOUT_MS / 1000} s, max ${MAX_BASH_TIMEOUT_MS / 1000} s. ` +
      "background:true gives a job id for {job, action}." +
      sandboxDescription(options.sandbox),
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer" },
        cwd: { type: "string", description: "Default: session cwd" },
        description: { type: "string" },
        background: { type: "boolean" },
        job: { type: "string" },
        action: { type: "string", enum: ["wait", "output", "stop", "extend"] },
        // [S2] 只在沙箱生效时出现：沙箱关闭的会话工具 schema 与以前逐字节相同
        ...(sandboxed ? { sandbox: { type: "boolean" } } : {}),
      },
      additionalProperties: false,
    },
    permission: "execute",
    executionMode: "sequential",
    annotations: { destructive: true, openWorld: true },
    promptSnippet: "bash: run shell commands (AMA_* env vars describe the session)",
    execute: (input, ctx) => executeBash(input, ctx, options),
  };
}
