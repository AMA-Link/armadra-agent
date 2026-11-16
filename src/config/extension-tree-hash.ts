/**
 * 目录扩展的整棵树哈希（#305）：信任以目录为单位，目录里任一文件变化都会让哈希变。
 *
 * 格式（v2，与平台、遍历与创建顺序无关）：对 sha256 依次写入
 *   `armadra-ext-tree-v2\n`，然后按「正斜杠相对路径」的 UTF-8 字节序排序的每一个文件：
 *   `F <相对路径的字节数> <相对路径> <内容字节数>\n` + 内容字节
 * 路径与内容都带长度前缀，所以不同的树不会拼出同一字节流。
 *
 * 不跳过任何项（包括 `.git`）：被跳过的文件照样可以被 `import`，就成了绕过信任的口子。符号链接一律跟随，
 * 按目标的内容计入（指向树外的也一样），目录链接递归进去；成环的链接、断开的链接按读不了处理。
 * socket、fifo 等其它类型忽略（不能被 import）。文件数、目录数、总字节与深度都有上限，超出抛
 * {@link TreeLimitError}；上限在读内容之前用 stat 检查。
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export const MAX_TREE_FILES = 2000;
export const MAX_TREE_BYTES = 50 * 1024 * 1024;
export const MAX_TREE_DIRS = 2000;
export const MAX_TREE_DEPTH = 32;

export interface TreeLimits {
  maxFiles: number;
  maxBytes: number;
  /** 缺省 {@link MAX_TREE_DIRS}。 */
  maxDirs?: number;
  /** 缺省 {@link MAX_TREE_DEPTH}。 */
  maxDepth?: number;
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
}

class TreeCycleError extends Error {}

function collect(root: string, limits: TreeLimits): Item[] {
  const maxDirs = limits.maxDirs ?? MAX_TREE_DIRS;
  const maxDepth = limits.maxDepth ?? MAX_TREE_DEPTH;
  const items: Item[] = [];
  let bytes = 0;
  let dirs = 0;
  // 当前递归路径上的目录真实路径：链接指回祖先即成环
  const ancestors = new Set<string>();
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > maxDepth) throw new TreeLimitError(`deeper than ${maxDepth} levels`);
    if (++dirs > maxDirs) throw new TreeLimitError(`more than ${maxDirs} directories`);
    const real = realpathSync(abs);
    if (ancestors.has(real)) throw new TreeCycleError(`symlink cycle at ${abs}`);
    ancestors.add(real);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      // 跟随符号链接（断开的链接在这里抛错 → 读不了）
      const stat = entry.isSymbolicLink() ? statSync(childAbs) : undefined;
      const isDir = stat !== undefined ? stat.isDirectory() : entry.isDirectory();
      const isFile = stat !== undefined ? stat.isFile() : entry.isFile();
      if (isDir) {
        walk(childAbs, childRel, depth + 1);
        continue;
      }
      if (!isFile) continue;
      if (items.length + 1 > limits.maxFiles) {
        throw new TreeLimitError(`more than ${limits.maxFiles} files`);
      }
      bytes += (stat ?? statSync(childAbs)).size;
      if (bytes > limits.maxBytes) throw new TreeLimitError(`more than ${limits.maxBytes} bytes`);
      items.push({ rel: childRel, abs: childAbs });
    }
    ancestors.delete(real);
  };
  walk(root, "", 0);
  return items;
}

/** 目录树的 sha256（十六进制）。读不了（含断开或成环的链接）抛错，超限抛 {@link TreeLimitError}。 */
export function sha256OfTree(root: string, limits: TreeLimits = DEFAULT_TREE_LIMITS): string {
  const items = collect(root, limits);
  const keyed = items.map((item) => ({ item, key: Buffer.from(item.rel, "utf8") }));
  keyed.sort((a, b) => Buffer.compare(a.key, b.key));
  const hash = createHash("sha256");
  hash.update("armadra-ext-tree-v2\n");
  for (const { item, key } of keyed) {
    const content = readFileSync(item.abs);
    hash.update(`F ${key.length} `);
    hash.update(key);
    hash.update(` ${content.length}\n`);
    hash.update(content);
  }
  return hash.digest("hex");
}
