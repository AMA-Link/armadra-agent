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
      .update("armadra-ext-tree-v1\nF 9 index.mjs 2\nab")
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

  it("跳过任意层级的 .git", () => {
    const a = join(root, "a");
    put(a, "index.mjs", "1");
    const base = sha256OfTree(a);
    put(a, ".git/HEAD", "ref");
    put(a, "lib/.git/x", "y");
    expect(sha256OfTree(a)).toBe(base);
  });

  it("上限：文件数与总字节数超出抛 TreeLimitError，等于上限不算超", () => {
    put(root, "a", "12");
    put(root, "b", "34");
    expect(() => sha256OfTree(root, { maxFiles: 2, maxBytes: 4 })).not.toThrow();
    expect(() => sha256OfTree(root, { maxFiles: 1, maxBytes: 100 })).toThrow(TreeLimitError);
    expect(() => sha256OfTree(root, { maxFiles: 10, maxBytes: 3 })).toThrow(TreeLimitError);
  });

  it("读不了的根目录抛原始错误（不是 TreeLimitError）", () => {
    expect(() => sha256OfTree(join(root, "missing"))).toThrow(/ENOENT/);
  });

  it.skipIf(process.platform === "win32")("符号链接按目标字符串计入，不跟随", () => {
    const a = join(root, "a");
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "one");
    put(a, "index.mjs", "1");
    symlinkSync(outside, join(a, "link"));
    const base = sha256OfTree(a);
    // 目标文件内容变化不影响哈希（没有跟随）
    writeFileSync(outside, "two");
    expect(sha256OfTree(a)).toBe(base);
    // 目标字符串变化才影响
    rmSync(join(a, "link"));
    symlinkSync(join(root, "other.txt"), join(a, "link"));
    expect(sha256OfTree(a)).not.toBe(base);
    // 指向目录的链接也不递归
    const b = join(root, "b");
    put(b, "index.mjs", "1");
    symlinkSync(a, join(b, "dir-link"));
    const withLink = sha256OfTree(b);
    put(a, "extra.js", "x");
    expect(sha256OfTree(b)).toBe(withLink);
  });
});
