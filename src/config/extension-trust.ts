/**
 * 本地扩展的信任（#301、#305，docs/guides/extensions.md）：按文件内容（目录扩展为整棵树）sha256 记在 trust.json 的 `extensions` 段。
 *
 * - `--no-trust`：全部不加载；`--trust` 与 profile `trustProject` 都不影响扩展。
 * - 记录的路径与哈希都相同 → 用记录的决定；没有记录或内容变了 → 交互模式一次性列出全部待定文件
 *   （路径 + sha256）询问，非交互直接跳过。
 * - 本模块只读文件、算哈希，不执行扩展代码（`ama doctor` 也用它）。
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_TREE_LIMITS,
  sha256OfTree,
  TreeLimitError,
  type TreeLimits,
} from "./extension-tree-hash.js";
import { readTrustFile, writeTrustFile, type TrustPromptAnswer } from "./trust.js";
import type { ExtensionTrustEntry } from "./types.js";

export type ExtensionTrustStatus =
  /** 记录匹配且已信任。 */
  | "trusted"
  /** 记录匹配且被拒绝。 */
  | "declined"
  /** 有该路径的记录，但内容已变（哈希不符）。 */
  | "changed"
  /** 没有记录。 */
  | "unknown"
  /** 文件读不了。 */
  | "unreadable"
  /** 目录扩展的文件数或总字节数超过上限（#305）。 */
  | "too-large";

export interface ExtensionFileInfo {
  path: string;
  /** 读不了文件时缺省。 */
  sha256?: string;
  /** 目录扩展（哈希覆盖整棵树，#305）。 */
  directory?: boolean;
  status: ExtensionTrustStatus;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 一个文件当前的信任状态（只读，不询问）。 */
export function inspectExtension(
  path: string,
  recorded: readonly ExtensionTrustEntry[],
  limits: TreeLimits = DEFAULT_TREE_LIMITS,
): ExtensionFileInfo {
  const abs = resolve(path);
  const directory = isDirectory(abs);
  const kind = directory ? { directory: true } : {};
  let sha256: string;
  try {
    sha256 = directory ? sha256OfTree(abs, limits) : sha256OfFile(abs);
  } catch (error) {
    return {
      path: abs,
      ...kind,
      status: error instanceof TreeLimitError ? "too-large" : "unreadable",
    };
  }
  const own = recorded.filter((e) => resolve(e.path) === abs);
  const match = own.find((e) => e.sha256 === sha256);
  if (match !== undefined) {
    return { path: abs, sha256, ...kind, status: match.trusted ? "trusted" : "declined" };
  }
  return { path: abs, sha256, ...kind, status: own.length > 0 ? "changed" : "unknown" };
}

/** 记录决定（同路径的旧记录被替换）。 */
export function recordExtensionTrust(
  configDir: string,
  files: readonly { path: string; sha256: string }[],
  trusted: boolean,
  now = new Date(),
): void {
  const file = readTrustFile(configDir);
  const paths = new Set(files.map((f) => resolve(f.path)));
  const extensions = (file.extensions ?? []).filter((e) => !paths.has(resolve(e.path)));
  for (const f of files) {
    extensions.push({
      path: resolve(f.path),
      sha256: f.sha256,
      trusted,
      at: now.toISOString(),
    });
  }
  writeTrustFile(configDir, { ...file, extensions });
}

export type ExtensionSkipReason =
  "no-trust" | "untrusted" | "changed" | "declined" | "unreadable" | "too-large";

export interface ExtensionSkipped {
  path: string;
  sha256?: string;
  directory?: boolean;
  reason: ExtensionSkipReason;
}

/** 询问时列出的一项；`directory` 标出目录扩展。 */
export interface ExtensionPromptFile {
  path: string;
  sha256: string;
  directory?: boolean;
}

export interface DecideExtensionsInput {
  paths: readonly string[];
  configDir: string;
  /** `--no-trust`。 */
  disabled: boolean;
  interactive: boolean;
  /** 交互询问（一次，列出全部待定文件）；不提供按非交互处理。 */
  prompt?: ((files: readonly ExtensionPromptFile[]) => Promise<TrustPromptAnswer>) | undefined;
  /** 目录扩展的树上限（测试可注入小值）。 */
  limits?: TreeLimits | undefined;
}

export interface ExtensionDecision {
  /** 按输入顺序的、可以加载的文件。 */
  load: string[];
  skipped: ExtensionSkipped[];
}

export async function decideExtensions(input: DecideExtensionsInput): Promise<ExtensionDecision> {
  if (input.paths.length === 0) return { load: [], skipped: [] };
  if (input.disabled) {
    return {
      load: [],
      skipped: input.paths.map((path) => ({ path, reason: "no-trust" as const })),
    };
  }
  const recorded = readTrustFile(input.configDir).extensions ?? [];
  const infos = input.paths.map((path) => inspectExtension(path, recorded, input.limits));
  const pending = infos.filter((i) => i.status === "unknown" || i.status === "changed");
  let answer: TrustPromptAnswer | undefined;
  if (pending.length > 0 && input.interactive && input.prompt !== undefined) {
    const files: ExtensionPromptFile[] = pending.map((i) => ({
      path: i.path,
      sha256: i.sha256 as string,
      ...(i.directory === true ? { directory: true } : {}),
    }));
    answer = await input.prompt(files);
    if (answer.remember) recordExtensionTrust(input.configDir, files, answer.trusted);
  }
  const load: string[] = [];
  const skipped: ExtensionSkipped[] = [];
  for (const [index, info] of infos.entries()) {
    const original = input.paths[index] as string;
    const base = {
      path: original,
      ...(info.sha256 !== undefined ? { sha256: info.sha256 } : {}),
      ...(info.directory === true ? { directory: true } : {}),
    };
    if (info.status === "trusted") load.push(original);
    else if (info.status === "unreadable" || info.status === "too-large") {
      skipped.push({ ...base, reason: info.status });
    } else if (info.status === "declined") skipped.push({ ...base, reason: "declined" });
    else if (answer !== undefined) {
      if (answer.trusted) load.push(original);
      else skipped.push({ ...base, reason: "declined" });
    } else skipped.push({ ...base, reason: info.status === "changed" ? "changed" : "untrusted" });
  }
  return { load, skipped };
}
