/**
 * 本地扩展的哈希信任（#301）：记录匹配 / 内容变了重新询问 / 非交互跳过 / --no-trust，
 * 以及 `ama doctor` 的列出（不执行扩展代码）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "../../test/helpers/bootstrap-harness.js";
import { sha256File, setupExtensionTrust } from "../../test/helpers/extension-trust.js";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { decideExtensions } from "../config/extension-trust.js";
import { readTrustFile } from "../config/trust.js";
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

function writeExt(name: string, id = name, marker = ""): string {
  const path = join(home.configDir, "extensions", `${name}.mjs`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `// ${marker}\nexport const hostApi = 1;\nexport function create() { globalThis.__loaded.push(${JSON.stringify(id)}); return { id: ${JSON.stringify(id)} }; }\n`,
  );
  return path;
}

const run = (argv: string[]) => runCli(argv, h.deps, h.io);

describe("信任决定", () => {
  it("记录的哈希匹配 → 加载；-p 下未记录的不加载并 warning；内容变了不再匹配", async () => {
    const a = writeExt("a");
    const b = writeExt("b");
    setupExtensionTrust(home.configDir, a);
    expect(await run(["-p", "hi"])).toBe(0);
    expect(loaded()).toEqual(["a"]);
    expect(h.err.join("")).toContain(b);
    expect(h.err.join("")).toContain("未信任");
    // 改 a 的内容：哈希不符，-p 下跳过，原因是「内容已变」
    writeFileSync(a, readFileSync(a, "utf8") + "// edited\n");
    h.err.length = 0;
    loaded().length = 0;
    expect(await run(["-p", "hi"])).toBe(0);
    expect(loaded()).toEqual([]);
    expect(h.err.join("")).toContain("内容自信任后已改变");
  });

  it("--no-trust：记录匹配的也一律不加载；--trust 与 profile trustProject 不影响扩展", async () => {
    const a = writeExt("a");
    const b = writeExt("b");
    setupExtensionTrust(home.configDir, a);
    expect(await run(["-p", "hi", "--no-trust"])).toBe(0);
    expect(loaded()).toEqual([]);
    expect(h.err.join("")).toContain("--no-trust");
    expect(await run(["-p", "hi", "--trust"])).toBe(0);
    expect(loaded()).toEqual(["a"]);
    const profile = home.write("profile.json", { version: 1, trustProject: true });
    loaded().length = 0;
    expect(await run(["-p", "hi", "--profile", profile])).toBe(0);
    expect(loaded()).toEqual(["a"]);
    expect(b).toBeTruthy();
  });

  it("交互：一次列出全部待定文件的路径与 sha256；记住后下次不再问，内容变了再问", async () => {
    const a = writeExt("a");
    const b = writeExt("b");
    const asked: { path: string; sha256: string }[][] = [];
    let answer = { trusted: true, remember: true };
    h.deps.ui = {
      promptExtensions: async (files) => {
        asked.push([...files]);
        return answer;
      },
    };
    expect(await run([])).toBe(0);
    expect(loaded()).toEqual(["a", "b"]);
    expect(asked).toEqual([
      [
        { path: a, sha256: sha256File(a) },
        { path: b, sha256: sha256File(b) },
      ],
    ]);
    const recorded = readTrustFile(home.configDir).extensions ?? [];
    expect(recorded.map((e) => [e.path, e.sha256, e.trusted])).toEqual([
      [a, sha256File(a), true],
      [b, sha256File(b), true],
    ]);
    // 再次启动：不再问
    loaded().length = 0;
    expect(await run([])).toBe(0);
    expect(asked).toHaveLength(1);
    expect(loaded()).toEqual(["a", "b"]);
    // 改 b：只重新询问 b；这次只信任本次（不记住）
    writeFileSync(b, readFileSync(b, "utf8") + "// edited\n");
    answer = { trusted: true, remember: false };
    loaded().length = 0;
    expect(await run([])).toBe(0);
    expect(asked[1]?.map((f) => f.path)).toEqual([b]);
    expect(loaded()).toEqual(["a", "b"]);
    expect(readTrustFile(home.configDir).extensions?.find((e) => e.path === b)?.sha256).toBe(
      recorded[1]?.sha256,
    );
  });

  it("询问界面出错：全部扩展跳过并 warning，启动照常（不变成启动失败）", async () => {
    writeExt("a");
    h.deps.ui = {
      promptExtensions: async () => {
        throw new Error("tty gone");
      },
    };
    expect(await run([])).toBe(0);
    expect(loaded()).toEqual([]);
    expect(h.err.join("")).toContain("信任判定失败：tty gone");
  });

  it("交互拒绝并记住：之后不再问也不加载；拒绝不记住：下次再问", async () => {
    writeExt("a");
    let count = 0;
    let remember = true;
    h.deps.ui = {
      promptExtensions: async () => {
        count++;
        return { trusted: false, remember };
      },
    };
    expect(await run([])).toBe(0);
    expect(await run([])).toBe(0);
    expect(count).toBe(1);
    expect(loaded()).toEqual([]);
    expect(readTrustFile(home.configDir).extensions?.[0]?.trusted).toBe(false);
    // 没有记录的新文件才会再问；不记住时每次都问
    home.cleanup();
    home = createTmpHome();
    h = harness(home);
    writeExt("a");
    remember = false;
    h.deps.ui = {
      promptExtensions: async () => {
        count++;
        return { trusted: false, remember };
      },
    };
    await run([]);
    await run([]);
    expect(count).toBe(3);
  });

  it("旧 trust.json（没有 extensions 段）照常读取；项目信任记录写入时不丢 extensions", async () => {
    home.write("home/.config/ama/trust.json", { version: 1, entries: [] });
    expect(readTrustFile(home.configDir).extensions).toBeUndefined();
    const a = writeExt("a");
    setupExtensionTrust(home.configDir, a);
    const { recordTrust } = await import("../config/trust.js");
    recordTrust(home.configDir, home.cwd, true);
    expect(readTrustFile(home.configDir).extensions).toHaveLength(1);
    expect(readTrustFile(home.configDir).entries).toHaveLength(1);
  });

  it("decideExtensions：读不了的文件跳过，没有 prompt 的交互按非交互处理", async () => {
    const missing = join(home.configDir, "extensions", "gone.mjs");
    const a = writeExt("a");
    const decision = await decideExtensions({
      paths: [missing, a],
      configDir: home.configDir,
      disabled: false,
      interactive: true,
    });
    expect(decision.load).toEqual([]);
    expect(decision.skipped.map((s) => s.reason)).toEqual(["unreadable", "untrusted"]);
  });
});

describe("ama doctor 列出扩展", () => {
  function doctorIo(out: string[]): CliIo {
    return { ...h.io, stdout: (t) => void out.push(t) };
  }

  it("列出启用 / 跳过、sha256 前缀与原因；不执行扩展代码", async () => {
    const a = writeExt("a");
    const b = writeExt("b");
    const c = writeExt("c");
    setupExtensionTrust(home.configDir, a);
    setupExtensionTrust(home.configDir, c, false);
    const out: string[] = [];
    expect(await runDoctor([], doctorIo(out), undefined)).toBe(0);
    const text = out.join("");
    expect(text).toContain("本地扩展");
    expect(text).toContain("不执行扩展代码");
    expect(text).toContain(`启用  ${a}  sha256 ${sha256File(a).slice(0, 12)}`);
    expect(text).toMatch(
      new RegExp(
        `跳过  ${b.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}  sha256 [0-9a-f]{12}  （未信任`,
      ),
    );
    expect(text).toContain("未信任）");
    expect(loaded()).toEqual([]);
    // 改 a：内容已变
    writeFileSync(a, readFileSync(a, "utf8") + "// edited\n");
    const out2: string[] = [];
    await runDoctor([], doctorIo(out2), undefined);
    expect(out2.join("")).toContain("内容自信任后已改变");
    // --no-trust
    const out3: string[] = [];
    await runDoctor(["--no-trust"], doctorIo(out3), undefined);
    expect(out3.join("")).toContain("--no-trust");
    expect(loaded()).toEqual([]);
  });

  it("没有扩展时只写一行说明", async () => {
    const out: string[] = [];
    await runDoctor([], doctorIo(out), undefined);
    expect(out.join("")).toContain("本地扩展");
    expect(out.join("")).toContain("无（用户级 extensions/");
  });
});
