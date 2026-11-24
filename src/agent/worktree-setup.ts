/**
 * [#313] worktree 初始化：`subagents.worktreeSetup`（只认用户级，项目配置不能借此执行命令）。
 *
 * 只在新建 worktree 时运行一次，cwd 是 worktree 根，`AMA_WORKTREE_PARENT` 指向父仓库（例如链接依赖目录）。
 * 失败、超时或被中止时删除这个 worktree 并让任务失败，不带着坏环境继续。
 */

import type { TaskRecord } from "../agents/task-record.js";
import { spawnShell } from "../tools/bash.js";
import { killProcessTree, trackProcessGroup, untrackProcessGroup } from "../tools/process-tree.js";
import { resolveShell } from "../tools/shell.js";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js";

export const WORKTREE_SETUP_TIMEOUT_MS = 600_000;
const OUTPUT_TAIL_CHARS = 2000;

export function runWorktreeSetup(
  command: string,
  tree: Pick<Worktree, "path" | "repo">,
  signal?: AbortSignal,
  timeoutMs = WORKTREE_SETUP_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const detached = process.platform !== "win32";
    const child = spawnShell(resolveShell(), command, {
      cwd: tree.path,
      env: { ...process.env, AMA_WORKTREE_PARENT: tree.repo },
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid !== undefined && detached) trackProcessGroup(pid);
    let tail = "";
    let stopped: string | undefined;
    const collect = (chunk: Buffer): void => {
      tail = (tail + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const stop = (reason: string): void => {
      stopped ??= reason;
      if (pid !== undefined) void killProcessTree(pid).catch(() => undefined);
    };
    const onAbort = (): void => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop(`timed out after ${timeoutMs} ms`), timeoutMs);
    timer.unref?.();
    const settle = (error?: Error): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (pid !== undefined && detached) untrackProcessGroup(pid);
      if (error === undefined) resolve();
      else reject(error);
    };
    child.once("error", (error) => settle(error));
    child.once("close", (code) => {
      if (stopped === undefined && code === 0) settle();
      else {
        const why = stopped ?? `exit code ${String(code)}`;
        settle(new Error(tail.trim() === "" ? why : `${why}: ${tail.trim()}`));
      }
    });
  });
}

/** 注册表 `execute()`：需要隔离且还没有 worktree 时建好（含初始化），子会话 cwd 指过去。 */
export async function prepareTaskWorktree(
  record: TaskRecord,
  cwd: string,
  sessionId: string,
  setup: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (record.isolation !== "worktree" || record.worktree !== undefined) return;
  // 名字带会话 id 前缀：不同会话的 t1 不会撞到同一个 worktree / 分支
  const tree = await createWorktree(cwd, `${sessionId.slice(0, 8)}-${record.info.taskId}`);
  if (setup !== undefined && setup.trim() !== "" && tree.created === true) {
    try {
      await runWorktreeSetup(setup, tree, signal);
    } catch (error) {
      await removeWorktree(tree).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`worktree setup failed (subagents.worktreeSetup): ${message}`);
    }
  }
  record.worktree = tree;
  record.cwd = tree.cwd;
}
