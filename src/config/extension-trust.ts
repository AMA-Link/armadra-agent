/**
 * 本地扩展的信任（#301，docs/guides/extensions.md）：按文件内容 sha256 记在 trust.json 的 `extensions` 段。
 *
 * - `--no-trust`：全部不加载；`--trust` 与 profile `trustProject` 都不影响扩展。
 * - 记录的路径与哈希都相同 → 用记录的决定；没有记录或内容变了 → 交互模式一次性列出全部待定文件
 *   （路径 + sha256）询问，非交互直接跳过。
 * - 本模块只读文件、算哈希，不执行扩展代码（`ama doctor` 也用它）。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  | "unreadable";

export interface ExtensionFileInfo {
  path: string;
  /** 读不了文件时缺省。 */
  sha256?: string;
  status: ExtensionTrustStatus;
}

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 一个文件当前的信任状态（只读，不询问）。 */
export function inspectExtension(
  path: string,
  recorded: readonly ExtensionTrustEntry[],
): ExtensionFileInfo {
  const abs = resolve(path);
  let sha256: string;
  try {
    sha256 = sha256OfFile(abs);
  } catch {
    return { path: abs, status: "unreadable" };
  }
  const own = recorded.filter((e) => resolve(e.path) === abs);
  const match = own.find((e) => e.sha256 === sha256);
  if (match !== undefined) {
    return { path: abs, sha256, status: match.trusted ? "trusted" : "declined" };
  }
  return { path: abs, sha256, status: own.length > 0 ? "changed" : "unknown" };
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

export type ExtensionSkipReason = "no-trust" | "untrusted" | "changed" | "declined" | "unreadable";

export interface ExtensionSkipped {
  path: string;
  sha256?: string;
  reason: ExtensionSkipReason;
}

export interface DecideExtensionsInput {
  paths: readonly string[];
  configDir: string;
  /** `--no-trust`。 */
  disabled: boolean;
  interactive: boolean;
  /** 交互询问（一次，列出全部待定文件）；不提供按非交互处理。 */
  prompt?:
    | ((files: readonly { path: string; sha256: string }[]) => Promise<TrustPromptAnswer>)
    | undefined;
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
  const infos = input.paths.map((path) => inspectExtension(path, recorded));
  const pending = infos.filter((i) => i.status === "unknown" || i.status === "changed");
  let answer: TrustPromptAnswer | undefined;
  if (pending.length > 0 && input.interactive && input.prompt !== undefined) {
    const files = pending.map((i) => ({ path: i.path, sha256: i.sha256 as string }));
    answer = await input.prompt(files);
    if (answer.remember) recordExtensionTrust(input.configDir, files, answer.trusted);
  }
  const load: string[] = [];
  const skipped: ExtensionSkipped[] = [];
  for (const [index, info] of infos.entries()) {
    const original = input.paths[index] as string;
    const base =
      info.sha256 !== undefined ? { path: original, sha256: info.sha256 } : { path: original };
    if (info.status === "trusted") load.push(original);
    else if (info.status === "unreadable") skipped.push({ ...base, reason: "unreadable" });
    else if (info.status === "declined") skipped.push({ ...base, reason: "declined" });
    else if (answer !== undefined) {
      if (answer.trusted) load.push(original);
      else skipped.push({ ...base, reason: "declined" });
    } else skipped.push({ ...base, reason: info.status === "changed" ? "changed" : "untrusted" });
  }
  return { load, skipped };
}
