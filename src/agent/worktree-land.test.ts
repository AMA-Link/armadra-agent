import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeToolContext } from "../../test/helpers/tool-context.js";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import {
  registerTaskControl,
  unregisterTaskControl,
  type TaskControl,
} from "../agents/task-control.js";
import { createTaskLandTool, refuseTaskLand } from "../tools/task-land.js";
import { createWorktree } from "./worktree.js";
import { landWorktree } from "./worktree-land.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo(): string {
  home = createTmpHome("ama-313-land-");
  const root = join(home.root, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.txt"), "one\n");
  writeFileSync(join(root, "b.txt"), "one\n");
  git(root, "init", "-q");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  return realpathSync.native(root);
}

const state = (root: string) => ({
  head: git(root, "rev-parse", "HEAD"),
  status: git(root, "status", "--porcelain"),
  staged: git(root, "diff", "--cached"),
  unstaged: git(root, "diff"),
});

describe.skipIf(!hasGit)("[#313] landWorktree", () => {
  it("只落地任务改动：继承的未提交改动留在父工作区、不进提交", async () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "parent dirty\n");
    writeFileSync(join(root, "new.txt"), "untracked\n");
    const tree = await createWorktree(root, "t1");
    writeFileSync(join(tree.path, "b.txt"), "task\n");
    const result = await landWorktree(tree, "task t1: edit b");
    expect(result).toMatchObject({ status: "landed" });
    expect(git(root, "show", "--name-only", "--format=%s", "HEAD").split("\n")).toEqual([
      "task t1: edit b",
      "",
      "b.txt",
    ]);
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("task\n");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("parent dirty\n");
    expect(git(root, "status", "--porcelain").split("\n").sort()).toEqual([
      "?? new.txt",
      "M a.txt",
    ]);
    expect(existsSync(tree.path)).toBe(false);
    expect(git(root, "branch", "--list", tree.branch)).toBe("");
    expect(git(root, "for-each-ref", "refs/ama")).toBe("");
  });

  it("没有改动：不产生提交，清理 worktree", async () => {
    const root = repo();
    const before = git(root, "rev-parse", "HEAD");
    const tree = await createWorktree(root, "t1");
    expect(await landWorktree(tree, "m")).toEqual({ status: "nothing" });
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
    expect(existsSync(tree.path)).toBe(false);
  });

  it("多提交中途冲突：父完全恢复，worktree 保留，报告冲突文件", async () => {
    const root = repo();
    const tree = await createWorktree(root, "t1");
    writeFileSync(join(tree.path, "b.txt"), "task b\n");
    git(tree.path, "commit", "-qam", "first");
    writeFileSync(join(tree.path, "a.txt"), "task a\n");
    git(tree.path, "commit", "-qam", "second");
    writeFileSync(join(root, "a.txt"), "main a\n");
    git(root, "commit", "-qam", "main moved");
    const before = state(root);
    const result = await landWorktree(tree, "m");
    expect(result).toMatchObject({ status: "blocked", files: ["a.txt"] });
    expect(state(root)).toEqual(before);
    expect(existsSync(tree.path)).toBe(true);
    expect(git(root, "branch", "--list", tree.branch)).toContain(tree.branch);
  });

  it("会覆盖父的未提交改动：拒绝并保持原样", async () => {
    const root = repo();
    const tree = await createWorktree(root, "t1");
    writeFileSync(join(tree.path, "a.txt"), "task\n");
    writeFileSync(join(root, "a.txt"), "parent dirty\n");
    const before = state(root);
    expect((await landWorktree(tree, "m")).status).toBe("blocked");
    expect(state(root)).toEqual(before);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("parent dirty\n");
    expect(existsSync(tree.path)).toBe(true);
  });

  it("父仓库有进行中的操作：拒绝，且不中止用户自己的 cherry-pick", async () => {
    const root = repo();
    const tree = await createWorktree(root, "t1");
    writeFileSync(join(tree.path, "b.txt"), "task\n");
    git(root, "checkout", "-q", "-b", "other");
    writeFileSync(join(root, "a.txt"), "other\n");
    git(root, "commit", "-qam", "other");
    const pick = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "-");
    writeFileSync(join(root, "a.txt"), "main\n");
    git(root, "commit", "-qam", "main");
    expect(() => git(root, "cherry-pick", pick)).toThrow();
    const result = await landWorktree(tree, "m");
    expect(result).toMatchObject({ status: "blocked" });
    expect(git(root, "rev-parse", "CHERRY_PICK_HEAD")).toBe(pick);
  });
});

describe("[#313] task_land 工具", () => {
  const control = (land: TaskControl["land"]) =>
    ({ get: () => ({ taskId: "t1" }), land }) as unknown as TaskControl;

  it("权限是 execute，走权限管线", () => {
    expect(createTaskLandTool().permission).toBe("execute");
  });

  it("子会话与协调者预设下拒绝，不触发落地", async () => {
    let calls = 0;
    const fake = control(async () => {
      calls++;
      return { status: "nothing" };
    });
    const ctx = { ...makeToolContext(home?.cwd ?? process.cwd()), sessionId: "s-land" };
    registerTaskControl("s-land", fake);
    try {
      const nested = await createTaskLandTool().execute({ taskId: "t1" }, { ...ctx, depth: 1 });
      expect(nested.isError).toBe(true);
      const coordinator = createTaskLandTool();
      refuseTaskLand(coordinator);
      expect((await coordinator.execute({ taskId: "t1" }, ctx)).isError).toBe(true);
      expect(calls).toBe(0);
      expect((await createTaskLandTool().execute({ taskId: "t1" }, ctx)).isError).toBeUndefined();
      expect(calls).toBe(1);
    } finally {
      unregisterTaskControl("s-land", fake);
    }
  });
});
