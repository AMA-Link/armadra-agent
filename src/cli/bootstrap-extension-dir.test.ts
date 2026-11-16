/** 目录扩展（#305）：发现、整树信任、子文件变化重新询问、上限、doctor 列出。 */

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "../../test/helpers/bootstrap-harness.js";
import { setupExtensionTrust } from "../../test/helpers/extension-trust.js";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { sha256OfTree } from "../config/extension-tree-hash.js";
import { decideExtensions, type ExtensionPromptFile } from "../config/extension-trust.js";
import { readTrustFile } from "../config/trust.js";
import { discoverExtensionDir, discoverExtensions } from "../host/extensions.js";
import { runCli } from "./bootstrap.js";
import type { CliIo } from "./deps.js";
import { runDoctor } from "./subcommands/doctor.js";

let home: TmpHome;
let h: Harness;
beforeEach(() => {
  home = createTmpHome();
  h = harness(home);
  (globalThis as { __loaded?: string[] }).__loaded = [];
});
afterEach(() => {
  delete (globalThis as { __loaded?: string[] }).__loaded;
  home.cleanup();
});

const loaded = (): string[] => (globalThis as { __loaded?: string[] }).__loaded as string[];
const extRoot = (): string => join(home.configDir, "extensions");

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** 单文件扩展。 */
function writeFile(name: string, id = name): string {
  const path = join(extRoot(), `${name}.mjs`);
  put(
    path,
    `export const hostApi = 1;\nexport function create() { globalThis.__loaded.push(${JSON.stringify(id)}); return { id: ${JSON.stringify(id)} }; }\n`,
  );
  return path;
}

/** 目录扩展：index 引入 lib/id.mjs，id 在子文件里（改子文件应触发重新询问）。 */
function writeDir(name: string, id = name, entry = "index.mjs"): string {
  const dir = join(extRoot(), name);
  put(join(dir, "lib", "id.mjs"), `export const id = ${JSON.stringify(id)};\n`);
  put(
    join(dir, entry),
    `import { id } from "./lib/id.mjs";\nexport const hostApi = 1;\nexport function create() { globalThis.__loaded.push(id); return { id }; }\n`,
  );
  return dir;
}

const run = (argv: string[]) => runCli(argv, h.deps, h.io);

describe("发现", () => {
  it("目录（index.mjs / index.cjs）与单文件按入口名一起排序；没有 index 的目录忽略", () => {
    const b = writeFile("b");
    const dirA = writeDir("a");
    const dirC = join(extRoot(), "c");
    put(join(dirC, "index.cjs"), "module.exports = {};");
    put(join(extRoot(), "empty", "readme.txt"), "x");
    put(join(extRoot(), "notes.txt"), "x");
    expect(discoverExtensionDir(home.configDir)).toEqual([dirA, b, dirC]);
  });

  it("profile extensions 可以是目录；同一路径只算一次", () => {
    const dir = writeDir("a");
    const other = join(home.root, "elsewhere");
    put(join(other, "index.mjs"), "export {};");
    expect(discoverExtensions(home.configDir, [dir, other])).toEqual([dir, other]);
    // 带尾部分隔符或 ./.. 的写法规整后去重
    expect(
      discoverExtensions(home.configDir, [`${dir}${sep}`, join(other, "..", "elsewhere"), other]),
    ).toEqual([dir, other]);
  });

  it.skipIf(process.platform === "win32")("指向目录的符号链接按目录扩展发现", () => {
    const real = writeDir("real");
    symlinkSync(real, join(extRoot(), "alias"));
    expect(discoverExtensionDir(home.configDir)).toEqual([join(extRoot(), "alias"), real]);
  });
});

describe("信任与加载", () => {
  it("交互：目录标为目录；信任后加载其 index；改子文件后重新询问", async () => {
    const dir = writeDir("a", "one");
    const asked: ExtensionPromptFile[][] = [];
    h.deps.ui = {
      promptExtensions: async (files) => {
        asked.push([...files]);
        return { trusted: true, remember: true };
      },
    };
    expect(await run([])).toBe(0);
    expect(loaded()).toEqual(["one"]);
    expect(asked).toEqual([[{ path: dir, sha256: sha256OfTree(dir), directory: true }]]);
    const entry = readTrustFile(home.configDir).extensions?.[0];
    expect([entry?.path, entry?.sha256, entry?.trusted]).toEqual([dir, sha256OfTree(dir), true]);
    // 再启动：不再问
    loaded().length = 0;
    expect(await run([])).toBe(0);
    expect(asked).toHaveLength(1);
    expect(loaded()).toEqual(["one"]);
    // 只改被 import 的子文件：重新询问，并记下新的树哈希
    put(join(dir, "lib", "id.mjs"), `export const id = "two";\n`);
    loaded().length = 0;
    expect(await run([])).toBe(0);
    expect(asked).toHaveLength(2);
    expect(asked[1]?.[0]?.directory).toBe(true);
    // 同一进程里 ESM 模块缓存会返回旧内容，这里只断言信任了新树后仍然加载
    expect(loaded()).toHaveLength(1);
    expect(readTrustFile(home.configDir).extensions?.[0]?.sha256).toBe(sha256OfTree(dir));
  });

  it("-p：子文件变了不加载，原因是内容已变；单文件扩展不受影响", async () => {
    const dir = writeDir("a", "one");
    const file = writeFile("f");
    setupExtensionTrust(home.configDir, dir);
    setupExtensionTrust(home.configDir, file);
    expect(await run(["-p", "hi"])).toBe(0);
    expect(loaded().sort()).toEqual(["f", "one"]);
    put(join(dir, "lib", "id.mjs"), `export const id = "two";\n`);
    loaded().length = 0;
    h.err.length = 0;
    expect(await run(["-p", "hi"])).toBe(0);
    expect(loaded()).toEqual(["f"]);
    expect(h.err.join("")).toContain("内容自信任后已改变");
  });

  it("index.cjs 的目录扩展可以加载", async () => {
    const dir = join(extRoot(), "c");
    put(
      join(dir, "index.cjs"),
      `exports.hostApi = 1;\nexports.create = () => { globalThis.__loaded.push("cjs"); return { id: "cjs" }; };\n`,
    );
    setupExtensionTrust(home.configDir, dir);
    expect(await run(["-p", "hi"])).toBe(0);
    expect(loaded()).toEqual(["cjs"]);
  });

  it("上限：超出文件数或字节数 → too-large 跳过，且不进询问；限内照常", async () => {
    const dir = writeDir("a");
    const asked: ExtensionPromptFile[][] = [];
    const prompt = async (files: readonly ExtensionPromptFile[]) => {
      asked.push([...files]);
      return { trusted: true, remember: false };
    };
    const base = {
      paths: [dir],
      configDir: home.configDir,
      disabled: false,
      interactive: true,
      prompt,
    };
    for (const limits of [
      { maxFiles: 1, maxBytes: 1_000_000 },
      { maxFiles: 10, maxBytes: 10 },
    ]) {
      const decision = await decideExtensions({ ...base, limits });
      expect(decision.load).toEqual([]);
      expect(decision.skipped).toEqual([{ path: dir, directory: true, reason: "too-large" }]);
    }
    expect(asked).toEqual([]);
    const ok = await decideExtensions({ ...base, limits: { maxFiles: 2, maxBytes: 1_000_000 } });
    expect(ok.load).toEqual([dir]);
    expect(asked).toHaveLength(1);
  });
});

describe("ama doctor 列出目录扩展", () => {
  it("标出目录、树哈希前缀；子文件变化显示内容已变", async () => {
    const dir = writeDir("a");
    const file = writeFile("b");
    setupExtensionTrust(home.configDir, dir);
    const out: string[] = [];
    const io: CliIo = { ...h.io, stdout: (t) => void out.push(t) };
    expect(await runDoctor([], io, undefined)).toBe(0);
    expect(out.join("")).toContain(`启用  [目录] ${dir}  sha256 ${sha256OfTree(dir).slice(0, 12)}`);
    expect(out.join("")).toContain(`跳过  ${file}`);
    put(join(dir, "lib", "id.mjs"), `export const id = "changed";\n`);
    const out2: string[] = [];
    await runDoctor([], { ...h.io, stdout: (t) => void out2.push(t) }, undefined);
    expect(out2.join("")).toMatch(/跳过 {2}\[目录\] .*内容自信任后已改变/);
    expect(loaded()).toEqual([]);
  });
});
