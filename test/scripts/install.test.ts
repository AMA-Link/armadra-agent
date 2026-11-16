import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const INSTALL = fileURLToPath(new URL("../../scripts/hooks/install.mjs", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ama-install-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** 测试自己起的 git 也不能带上调用方（例如钩子）的 GIT_*。 */
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);
const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", env });

/** 一个带 .githooks/pre-push 与 scripts/hooks/install.mjs 的临时仓库。 */
function repo(name: string, hooks = true): string {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "scripts/hooks"), { recursive: true });
  expect(git(dir, ["init", "-q"]).status).toBe(0);
  copyFileSync(INSTALL, join(dir, "scripts/hooks/install.mjs"));
  if (hooks) {
    mkdirSync(join(dir, ".githooks"));
    writeFileSync(join(dir, ".githooks/pre-push"), "#!/bin/sh\n");
  }
  return dir;
}

const hooksPath = (dir: string) =>
  git(dir, ["config", "--local", "--get", "core.hooksPath"]).stdout.trim();
const install = (dir: string, extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, [join(dir, "scripts/hooks/install.mjs")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...env, ...extra },
  });

describe("scripts/hooks/install.mjs", () => {
  it("设到自己仓库；GIT_DIR 指向别的仓库时也不写进那个仓库", () => {
    const caller = repo("caller", false);
    const target = repo("target");
    const result = install(target, {
      GIT_DIR: join(caller, ".git"),
      GIT_WORK_TREE: caller,
      GIT_INDEX_FILE: join(caller, ".git/index"),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(hooksPath(target)).toBe(".githooks");
    expect(hooksPath(caller)).toBe("");
  });

  it("已经设成别的值不改；没有 .githooks 什么都不做", () => {
    const custom = repo("custom");
    git(custom, ["config", "--local", "core.hooksPath", "my-hooks"]);
    expect(install(custom).status).toBe(0);
    expect(hooksPath(custom)).toBe("my-hooks");
    const plain = repo("plain", false);
    expect(install(plain).status).toBe(0);
    expect(hooksPath(plain)).toBe("");
  });
});
