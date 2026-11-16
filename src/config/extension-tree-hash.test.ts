/** 目录扩展的树哈希（#305）：稳定、与创建顺序无关、子文件变化、上限、符号链接。 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256OfTree, TreeLimitError } from "./extension-tree-hash.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ama-tree-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(base: string, rel: string, content: string): void {
  const file = join(base, ...rel.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

describe("sha256OfTree", () => {
  it("格式固定：与手算的字节流一致（相对路径与内容都带长度前缀）", () => {
    put(root, "index.mjs", "ab");
    put(root, "lib/x.js", "c");
    const expected = createHash("sha256")
      .update("armadra-ext-tree-v2\nF 9 index.mjs 2\nab")
      .update("F 8 lib/x.js 1\nc")
      .digest("hex");
    expect(sha256OfTree(root)).toBe(expected);
  });

  it("与创建顺序无关；内容、路径、嵌套文件的变化都会改变哈希", () => {
    const a = join(root, "a");
    const b = join(root, "b");
    put(a, "index.mjs", "1");
    put(a, "lib/deep/x.js", "2");
    put(a, "z.js", "3");
    put(b, "z.js", "3");
    put(b, "lib/deep/x.js", "2");
    put(b, "index.mjs", "1");
    const base = sha256OfTree(a);
    expect(sha256OfTree(b)).toBe(base);
    put(a, "lib/deep/x.js", "2!");
    expect(sha256OfTree(a)).not.toBe(base);
    put(a, "lib/deep/x.js", "2");
    expect(sha256OfTree(a)).toBe(base);
    put(a, "lib/deep/y.js", "");
    expect(sha256OfTree(a)).not.toBe(base);
  });

  it("路径与内容不会拼出歧义：把内容挪到另一个文件名里哈希不同", () => {
    const a = join(root, "a");
    const b = join(root, "b");
    put(a, "x", "yz");
    put(b, "xy", "z");
    expect(sha256OfTree(a)).not.toBe(sha256OfTree(b));
  });

  it("不跳过 .git：其中的文件同样计入（能被 import 就必须受哈希保护）", () => {
    const a = join(root, "a");
    put(a, "index.mjs", "1");
    const base = sha256OfTree(a);
    put(a, ".git/x.mjs", "evil");
    const withGit = sha256OfTree(a);
    expect(withGit).not.toBe(base);
    put(a, ".git/x.mjs", "evil2");
    expect(sha256OfTree(a)).not.toBe(withGit);
  });

  it("上限：文件数与总字节数超出抛 TreeLimitError，等于上限不算超", () => {
    put(root, "a", "12");
    put(root, "b", "34");
    expect(() => sha256OfTree(root, { maxFiles: 2, maxBytes: 4 })).not.toThrow();
    expect(() => sha256OfTree(root, { maxFiles: 1, maxBytes: 100 })).toThrow(TreeLimitError);
    expect(() => sha256OfTree(root, { maxFiles: 10, maxBytes: 3 })).toThrow(TreeLimitError);
  });

  it("上限：目录数与深度超出抛 TreeLimitError", () => {
    put(root, "a/b/c/x", "1");
    expect(() => sha256OfTree(root, { maxFiles: 10, maxBytes: 10, maxDepth: 3 })).not.toThrow();
    expect(() => sha256OfTree(root, { maxFiles: 10, maxBytes: 10, maxDepth: 2 })).toThrow(
      TreeLimitError,
    );
    expect(() => sha256OfTree(root, { maxFiles: 10, maxBytes: 10, maxDirs: 4 })).not.toThrow();
    expect(() => sha256OfTree(root, { maxFiles: 10, maxBytes: 10, maxDirs: 3 })).toThrow(
      TreeLimitError,
    );
  });

  it("读不了的根目录抛原始错误（不是 TreeLimitError）", () => {
    expect(() => sha256OfTree(join(root, "missing"))).toThrow(/ENOENT/);
  });

  it.skipIf(process.platform === "win32")("符号链接跟随：按目标内容计入，目录链接递归", () => {
    const a = join(root, "a");
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "one");
    put(a, "index.mjs", "1");
    symlinkSync(outside, join(a, "link"));
    const base = sha256OfTree(a);
    // 树外目标的内容变化也会改变哈希
    writeFileSync(outside, "two");
    expect(sha256OfTree(a)).not.toBe(base);
    // 与把同样内容的普通文件放在原处等价（只看内容）
    const plain = join(root, "plain");
    put(plain, "index.mjs", "1");
    put(plain, "link", "two");
    expect(sha256OfTree(a)).toBe(sha256OfTree(plain));
    // 指向目录的链接递归进去
    const b = join(root, "b");
    put(b, "index.mjs", "1");
    symlinkSync(join(root, "shared"), join(b, "lib"));
    put(root, "shared/x.js", "x");
    const withLink = sha256OfTree(b);
    put(root, "shared/x.js", "y");
    expect(sha256OfTree(b)).not.toBe(withLink);
  });

  it.skipIf(process.platform === "win32")("成环或断开的链接按读不了抛错", () => {
    const a = join(root, "a");
    put(a, "index.mjs", "1");
    symlinkSync(a, join(a, "loop"));
    expect(() => sha256OfTree(a)).toThrow(/cycle/);
    expect(() => sha256OfTree(a)).not.toThrow(TreeLimitError);
    const b = join(root, "b");
    put(b, "index.mjs", "1");
    symlinkSync(join(root, "missing"), join(b, "dangling"));
    expect(() => sha256OfTree(b)).toThrow(/ENOENT/);
  });
});
