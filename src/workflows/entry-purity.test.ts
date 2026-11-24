import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set(
  [
    "workflow.ts",
    "workflows/types.ts",
    "workflows/validate.ts",
    "workflows/render.ts",
    "workflows/glob.ts",
    "workflows/json-schema.ts",
    "workflows/file.ts",
    "workflows/yaml.ts",
    "agents/tier-ladder.ts",
  ].map((p) => path.join(SRC, p)),
);

/** 运行期 import（`import type` / `export type` 与内联 `type` 说明符不算）。 */
function runtimeImports(source: string): string[] {
  const found: string[] = [];
  const re =
    /\b(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(re)) {
    if (m[2] !== undefined) continue;
    const clause = m[3];
    if (clause !== undefined && /^\{[^}]*\}$/.test(clause.trim())) {
      const names = clause
        .trim()
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith("type "))) continue;
    }
    found.push((m[4] ?? m[5] ?? m[6])!);
  }
  return found;
}

describe("./workflow entry purity", () => {
  it("reaches only the allowed pure modules", () => {
    const seen = new Set<string>();
    const queue = [path.join(SRC, "workflow.ts")];
    const bad: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (!ALLOWED.has(file)) bad.push(path.relative(SRC, file));
      for (const spec of runtimeImports(readFileSync(file, "utf8"))) {
        if (!spec.startsWith(".")) {
          bad.push(`${path.relative(SRC, file)} -> ${spec}`);
          continue;
        }
        queue.push(path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")));
      }
    }
    expect(bad).toEqual([]);
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });
  it("detects forbidden imports", () => {
    expect(runtimeImports(`import fs from "node:fs";\nimport type { A } from "./x.js";`)).toEqual([
      "node:fs",
    ]);
    expect(runtimeImports(`import { type A } from "./a.js";`)).toEqual([]);
    expect(runtimeImports(`export { b } from "../i18n/index.js";`)).toEqual(["../i18n/index.js"]);
  });
});
