/**
 * `bash` 工具的后台任务面（从 bash.ts 拆出，保持 ≤ 600 行）。[W5-H2 → #266 / #267]
 *
 * - `startBackground`：`{ command, background: true }` → 登记并立即返回 `{ jobId, outputPath, pid }`；
 * - `movedResult`：[#266] 前台命令超过阈值被原地转后台时的工具结果（已有输出的尾部 + 固定英文说明）；
 * - `jobAction`：`{ job, action: wait | output | stop | extend }`；查询输出按会话结果上限尾截断（#155）；
 *   [#267] `extend` 续命一次（`timeoutMs` = 增量，缺省与上限相同，封顶一个上限）。
 *
 * 进程只在 bash.ts 的 `spawnShell` 创建：这里经调用方传入的 `spawn` 闭包启动，自己不 import spawn。
 */

import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { BackgroundStart, BashInput, BashToolOptions } from "./bash.js";
import {
  jobsForSession,
  type BackgroundJobs,
  type ExtendOutcome,
  type Job,
} from "./background-jobs.js";
import { minutesOf } from "./timers.js";
import { formatSize, resolveOutputDir, safeFileName, toolOutputBytes } from "./truncate.js";
import type { ToolContext, ToolResult } from "./types.js";

/** [#267] 后台命令的寿命上限缺省：2 小时。 */
export const DEFAULT_BASH_BACKGROUND_MAX_MS = 7_200_000;
/** [#266] 协调者 / RPC / ACP / 嵌入宿主下自动转后台的缺省阈值。 */
export const DEFAULT_BASH_AUTO_BACKGROUND_MS = 15_000;

export function fail(message: string): ToolResult {
  return { content: message, isError: true };
}

export function jobsOf(ctx: ToolContext, options: BashToolOptions): BackgroundJobs {
  return options.jobs ? options.jobs(ctx.sessionId) : jobsForSession(ctx.sessionId);
}

/** [#267] 本会话后台任务的寿命上限（0 = 不限）。 */
export function backgroundMaxMs(options: BashToolOptions): number {
  return options.backgroundMaxMs ?? DEFAULT_BASH_BACKGROUND_MAX_MS;
}

function lifetimeNote(job: Job): string {
  return job.lifetime === undefined
    ? ""
    : ` It is stopped after ${minutesOf(job.lifetime.maxMs)} unless extended once with {"job":"${job.id}","action":"extend"}.`;
}

export function startBackground(
  command: string,
  spawn: (outputFd: number) => ChildProcess,
  shellName: string,
  cwd: string,
  sandboxed: boolean,
  ctx: ToolContext,
  options: BashToolOptions,
): ToolResult {
  const outputPath = join(
    resolveOutputDir(ctx.outputDir),
    safeFileName(`bash-bg-${ctx.toolCallId}.log`),
  );
  let job: Job;
  try {
    job = jobsOf(ctx, options).start(command, {
      cwd,
      outputPath,
      spawn,
      maxMs: backgroundMaxMs(options),
      ...(options.processDeps === undefined ? {} : { processDeps: options.processDeps }),
      ...(options.timers === undefined ? {} : { timers: options.timers }),
    });
  } catch (err) {
    return fail(`Failed to start shell ${shellName}: ${(err as Error).message}`);
  }
  const structured: BackgroundStart = { jobId: job.id, outputPath: job.outputPath };
  if (job.pid !== undefined) structured.pid = job.pid;
  if (sandboxed) structured.sandboxed = true;
  return {
    content:
      `Started background job ${job.id}${job.pid !== undefined ? ` (pid ${job.pid})` : ""}; ` +
      `output: ${job.outputPath}. Check it with bash {"job":"${job.id}","action":"wait"|"output"|"stop"}; ` +
      `you will be told when it exits.${lifetimeNote(job)}`,
    structured,
    details: { ...structured, background: true, command, cwd },
  };
}

/** [#266] 前台命令转后台的结果：到此刻的输出尾部 + 固定说明；不算错误。 */
export function movedResult(
  job: Job,
  tail: string,
  afterMs: number,
  sandboxed: boolean,
  command: string,
): ToolResult {
  const structured: BackgroundStart & { movedToBackground: true; output: string } = {
    jobId: job.id,
    outputPath: job.outputPath,
    movedToBackground: true,
    output: tail,
  };
  if (job.pid !== undefined) structured.pid = job.pid;
  if (sandboxed) structured.sandboxed = true;
  const note =
    `[Still running after ${Math.round(afterMs / 1000)}s; moved to background job ${job.id}` +
    `${job.pid !== undefined ? ` (pid ${job.pid})` : ""}; it was not interrupted. Output so far is ` +
    `above; full output: ${job.outputPath}. Check it with bash {"job":"${job.id}","action":"wait"|"output"|"stop"}; ` +
    `you will be told when it exits. Do not wait for it unless the user asks.${lifetimeNote(job)}]`;
  return {
    content: `${tail === "" ? "(no output)" : tail}\n\n${note}`,
    structured,
    details: { ...structured, background: true, command, cwd: job.cwd, afterMs },
  };
}

function jobStatusLine(job: Job): string {
  const state =
    job.status === "running"
      ? "still running"
      : job.status === "stopped"
        ? job.expired === true
          ? `stopped at its lifetime cap (${minutesOf(job.lifetime?.maxMs ?? 0)}; exit code ${job.exitCode ?? "?"})`
          : `stopped (exit code ${job.exitCode ?? "?"})`
        : `exited with code ${job.exitCode ?? "?"}`;
  return `[job ${job.id} ${state}; output: ${job.outputPath}]`;
}

function extendText(id: string, outcome: ExtendOutcome): ToolResult {
  if (outcome.ok)
    return {
      content: `[job ${id} lifetime extended by ${minutesOf(outcome.addedMs)}; it is now stopped after ${minutesOf(outcome.totalMs)} in total. It cannot be extended again.]`,
      structured: { jobId: id, extendedMs: outcome.addedMs, totalMs: outcome.totalMs },
    };
  switch (outcome.reason) {
    case "unknown":
      return fail(`Unknown background job ${id}`);
    case "not_running":
      return fail(`Job ${id} is not running; nothing to extend.`);
    case "no_cap":
      return { content: `[job ${id} has no lifetime cap; nothing to extend]` };
    case "already_extended":
      return fail(`Job ${id} was already extended once; it cannot be extended again.`);
  }
}

export async function jobAction(
  input: BashInput,
  ctx: ToolContext,
  options: BashToolOptions,
  maxWaitMs: number,
  defaultWaitMs: number,
): Promise<ToolResult> {
  const id = input.job as string;
  if (input.command !== undefined || input.background === true || input.sandbox !== undefined)
    return fail("job queries take only job, action and timeoutMs");
  const action = input.action ?? "output";
  const jobs = jobsOf(ctx, options);
  if (jobs.get(id) === undefined) {
    const known = jobs.list().map((job) => job.id);
    return fail(
      `Unknown background job ${id}${known.length > 0 ? ` (jobs: ${known.join(", ")})` : ""}`,
    );
  }
  if (action === "extend") {
    const ms = input.timeoutMs;
    if (ms !== undefined && (!Number.isFinite(ms) || ms <= 0))
      return fail("timeoutMs for extend must be a positive number of milliseconds");
    return extendText(id, jobs.extend(id, ms));
  }
  if (action === "stop") {
    const job = (await jobs.stop(id)) as Job;
    const out = jobs.output(id, { maxBytes: toolOutputBytes(ctx.maxResultChars) });
    const text = out?.content ?? "";
    return {
      content: `${text === "" ? "(no output)" : text}\n\n${jobStatusLine(job)}`,
      structured: { jobId: id, status: job.status, exit_code: job.exitCode ?? null },
    };
  }
  if (action === "wait") {
    const waitMs = input.timeoutMs ?? defaultWaitMs;
    if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs > maxWaitMs)
      return fail(`timeoutMs must be between 1 and ${maxWaitMs}`);
    await jobs.wait(id, waitMs, ctx.signal);
  }
  const out = jobs.output(id, { maxBytes: toolOutputBytes(ctx.maxResultChars) });
  if (out === undefined) return fail(`Unknown background job ${id}`);
  const job = out.job;
  if (job.status !== "running") jobs.markSeen(id);
  const parts = [out.content === "" ? "(no output)" : out.content];
  if (out.truncated)
    parts.push(
      `[Output truncated: showing the last ${out.outputLines} of ${out.totalLines} lines ` +
        `(${formatSize(out.totalBytes)} total). Full output: ${job.outputPath}]`,
    );
  parts.push(jobStatusLine(job));
  return {
    content: parts.join("\n\n"),
    isError: job.status === "exited" && job.exitCode !== 0,
    structured: { jobId: id, status: job.status, exit_code: job.exitCode ?? null },
  };
}
