/** 测试里给扩展文件预先记下「已信任」（按内容 sha256 写进 trust.json 的 extensions 段）。 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256OfTree } from "../../src/config/extension-tree-hash.js";

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function setupExtensionTrust(configDir: string, path: string, trusted = true): void {
  mkdirSync(configDir, { recursive: true });
  const file = join(configDir, "trust.json");
  const current = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as {
        version: 1;
        entries: unknown[];
        extensions?: unknown[];
      })
    : { version: 1 as const, entries: [] };
  const extensions = (current.extensions ?? []).filter(
    (e) => (e as { path: string }).path !== path,
  );
  const sha256 = statSync(path).isDirectory() ? sha256OfTree(path) : sha256File(path);
  extensions.push({ path, sha256, trusted, at: new Date().toISOString() });
  writeFileSync(file, JSON.stringify({ ...current, extensions }, null, 2));
}
