/**
 * 目录扩展的整棵树哈希（#305）：信任以目录为单位，目录里任一文件变化都会让哈希变。
 *
 * 格式（v1，与平台、遍历与创建顺序无关）：对 sha256 依次写入
 *   `armadra-ext-tree-v1\n`，然后按「正斜杠相对路径」的 UTF-8 字节序排序的每一项：
 *   `<F|L> <相对路径的字节数> <相对路径> <内容字节数>\n` + 内容字节
 * 其中 F 是常规文件（内容为文件字节），L 是符号链接（内容为链接目标字符串的 UTF-8，不跟随）。
 * 路径与内容都带长度前缀，所以不同的树不会拼出同一字节流。跳过任意层级名为 `.git` 的项；
 * 其它类型（socket、fifo 等）忽略。
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export const MAX_TREE_FILES = 2000;
export const MAX_TREE_BYTES = 50 * 1024 * 1024;

export interface TreeLimits {
  maxFiles: number;
  maxBytes: number;
}

export const DEFAULT_TREE_LIMITS: TreeLimits = {
  maxFiles: MAX_TREE_FILES,
  maxBytes: MAX_TREE_BYTES,
};

/** 文件数或总字节数超过上限（与「读不了」区分开）。 */
export class TreeLimitError extends Error {}

interface Item {
  rel: string;
  abs: string;
  link: boolean;
}

function collect(root: string, limits: TreeLimits): { items: Item[]; sizes: Map<string, number> } {
  const items: Item[] = [];
  const sizes = new Map<string, number>();
  let bytes = 0;
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const childAbs = join(abs, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      const link = entry.isSymbolicLink();
      if (!link && !entry.isFile()) continue;
      if (items.length + 1 > limits.maxFiles) {
        throw new TreeLimitError(`more than ${limits.maxFiles} files`);
      }
      const size = link ? Buffer.byteLength(readlinkSync(childAbs)) : lstatSync(childAbs).size;
      bytes += size;
      if (bytes > limits.maxBytes) throw new TreeLimitError(`more than ${limits.maxBytes} bytes`);
      items.push({ rel: childRel, abs: childAbs, link });
      sizes.set(childRel, size);
    }
  };
  walk(root, "");
  return { items, sizes };
}

/** 目录树的 sha256（十六进制）。读不了抛原始 fs 错误，超限抛 {@link TreeLimitError}。 */
export function sha256OfTree(root: string, limits: TreeLimits = DEFAULT_TREE_LIMITS): string {
  const { items } = collect(root, limits);
  const keyed = items.map((item) => ({ item, key: Buffer.from(item.rel, "utf8") }));
  keyed.sort((a, b) => Buffer.compare(a.key, b.key));
  const hash = createHash("sha256");
  hash.update("armadra-ext-tree-v1\n");
  for (const { item, key } of keyed) {
    const content = item.link
      ? Buffer.from(readlinkSync(item.abs), "utf8")
      : readFileSync(item.abs);
    hash.update(`${item.link ? "L" : "F"} ${key.length} `);
    hash.update(key);
    hash.update(` ${content.length}\n`);
    hash.update(content);
  }
  return hash.digest("hex");
}
