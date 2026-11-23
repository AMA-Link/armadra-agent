/**
 * [#313] 把 worktree 子任务的结果落到父仓库当前分支。
 *
 * - 遗留改动先在任务分支上提交，再 cherry-pick `起点..任务分支`：起点是未提交改动的快照时，快照本身不会
 *   被落地；
 * - 父仓库正在 merge / rebase / cherry-pick 时直接拒绝：失败回退用的 `--abort` 不能碰用户自己的操作；
 * - 冲突或会覆盖父的未提交改动：`cherry-pick --abort` 恢复原状，保留 worktree，报告冲突文件；
 * - 整个过程占用该仓库的串行队列，并行落地不会交错。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  removeWorktree,
  retryTransient,
  runGit,
  withRepoLock,
  type GitRunner,
  type Worktree,
} from "./worktree.js";

export type LandResult =
  | { status: "landed"; commits: string[]; cleanupError?: string }
  | { status: "nothing" }
  | { status: "blocked"; reason: string; files?: string[] };

const IN_PROGRESS = [
  "CHERRY_PICK_HEAD",
  "MERGE_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
];

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split("\n").slice(0, 6).join("\n");

async function gitPathExists(repo: string, name: string, git: GitRunner): Promise<boolean> {
  return existsSync(resolve(repo, (await git(["rev-parse", "--git-path", name], repo)).trim()));
}

async function operationInProgress(repo: string, git: GitRunner): Promise<string | undefined> {
  for (const name of IN_PROGRESS) if (await gitPathExists(repo, name, git)) return name;
  return undefined;
}

/** 回退这次 cherry-pick；返回 HEAD 是否回到了开始时的提交。 */
async function rollback(repo: string, before: string, git: GitRunner): Promise<boolean> {
  if (
    (await gitPathExists(repo, "CHERRY_PICK_HEAD", git)) ||
    (await gitPathExists(repo, "sequencer", git))
  )
    await git(["cherry-pick", "--abort"], repo);
  return (await git(["rev-parse", "HEAD"], repo)).trim() === before;
}

async function landLocked(tree: Worktree, message: string, git: GitRunner): Promise<LandResult> {
  const repo = tree.repo;
  if ((await git(["status", "--porcelain"], tree.path)).trim() !== "") {
    try {
      await git(["add", "-A"], tree.path);
      await git(["commit", "-q", "-m", message], tree.path);
    } catch (error) {
      return {
        status: "blocked",
        reason: `could not commit the task's changes: ${errorText(error)}`,
      };
    }
  }
  const range = `${tree.base}..${tree.branch}`;
  const commits = lines(await git(["rev-list", "--reverse", range], repo));
  if (commits.length === 0) {
    await removeWorktree(tree, git, true);
    return { status: "nothing" };
  }
  if (lines(await git(["rev-list", "--merges", range], repo)).length > 0)
    return { status: "blocked", reason: "the task branch contains merge commits" };
  const busy = await operationInProgress(repo, git);
  if (busy !== undefined)
    return { status: "blocked", reason: `the parent repository has an operation open (${busy})` };
  const before = (await git(["rev-parse", "HEAD"], repo)).trim();
  try {
    await git(["-c", "core.editor=true", "cherry-pick", ...commits], repo);
  } catch (error) {
    const files = lines(
      await git(["diff", "--name-only", "--diff-filter=U"], repo).catch(() => ""),
    );
    const restored = await rollback(repo, before, git).catch(() => false);
    const reason = restored
      ? `not landed, parent restored: ${errorText(error)}`
      : `cherry-pick failed and the parent could not be restored to ${before}: ${errorText(error)}`;
    return files.length > 0 ? { status: "blocked", reason, files } : { status: "blocked", reason };
  }
  const landed = lines(await git(["rev-list", "--reverse", `${before}..HEAD`], repo));
  try {
    await retryTransient(() => removeWorktree(tree, git, true));
    return { status: "landed", commits: landed };
  } catch (error) {
    return { status: "landed", commits: landed, cleanupError: errorText(error) };
  }
}

export function landWorktree(
  tree: Worktree,
  message: string,
  git: GitRunner = runGit,
): Promise<LandResult> {
  return withRepoLock(tree.repo, () => landLocked(tree, message, git), git);
}
