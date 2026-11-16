/**
 * trust.json 的校验（从 schema.ts 拆出，#301 加了 `extensions` 段）。
 */

import { msg } from "../i18n/index.js";
import { Checker, join, type Diagnostic } from "./checker.js";
import type { TrustFile } from "./types.js";

export function validateTrustFile(value: unknown): Diagnostic[] {
  const c = new Checker();
  if (!c.object(value, "")) return c.diagnostics;
  c.version(value, "");
  const entries = value["entries"];
  if (!Array.isArray(entries)) {
    c.error("entries", msg().config.schema.array);
    return c.diagnostics;
  }
  entries.forEach((entry: unknown, index) => {
    const p = join("entries", index);
    if (!c.object(entry, p)) return;
    c.string(entry, "path", p, true);
    c.string(entry, "at", p, true);
    if (typeof entry["trusted"] !== "boolean")
      c.error(join(p, "trusted"), msg().config.schema.boolean);
  });
  const extensions = value["extensions"];
  if (extensions !== undefined) {
    if (!Array.isArray(extensions)) {
      c.error("extensions", msg().config.schema.array);
      return c.diagnostics;
    }
    extensions.forEach((entry: unknown, index) => {
      const p = join("extensions", index);
      if (!c.object(entry, p)) return;
      c.string(entry, "path", p, true);
      c.string(entry, "sha256", p, true);
      c.string(entry, "at", p, true);
      if (typeof entry["trusted"] !== "boolean")
        c.error(join(p, "trusted"), msg().config.schema.boolean);
    });
  }
  return c.diagnostics;
}

export function asTrustFile(value: unknown): TrustFile {
  return value as TrustFile;
}
