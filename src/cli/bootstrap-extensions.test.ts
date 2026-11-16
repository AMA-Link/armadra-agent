/**
 * 本地扩展的启动接缝（#301）：多模块共存规则、失败只 warning、逆序 dispose。
 * 扩展文件写进临时 configDir/extensions；它们通过 globalThis.__ext 把观察到的事情交给测试。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "../../test/helpers/bootstrap-harness.js";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { runCli } from "./bootstrap.js";
import type { HostApi } from "../host/types.js";
import { setupExtensionTrust } from "../../test/helpers/extension-trust.js";

interface ExtGlobal {
  __ext?: { apis: Record<string, HostApi>; order: string[]; events: string[] };
}
const g = globalThis as ExtGlobal;

let home: TmpHome;
let h: Harness;

beforeEach(() => {
  home = createTmpHome();
  h = harness(home);
  g.__ext = { apis: {}, order: [], events: [] };
});
afterEach(() => {
  delete g.__ext;
  home.cleanup();
});

const run = (argv: string[]) => runCli(argv, h.deps, h.io);

/** 写一个扩展并记下 api；body 是 create 里额外执行的语句。 */
function ext(name: string, body = "", file = `${name}.mjs`, extra = ""): string {
  const path = join(home.configDir, "extensions", file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `export const hostApi = 1;
${extra}
export function create(api) {
  globalThis.__ext.apis[${JSON.stringify(name)}] = api;
  ${body}
  return { id: ${JSON.stringify(name)}, dispose() { globalThis.__ext.order.push(${JSON.stringify(`dispose:${name}`)}); } };
}
`,
  );
  setupExtensionTrust(home.configDir, path);
  return path;
}

const tool = (name: string) =>
  `api.tools.register({ name: ${JSON.stringify(name)}, description: "d", parameters: { type: "object" }, permission: "read", execute: async () => ({ content: "" }) });`;

describe("本地扩展共存", () => {
  it("两个扩展 + 宿主适配器：工具、指令、事件、状态都在；重名工具只失败第二个", async () => {
    home.write(
      "work/host.cjs",
      `module.exports = { hostApi: 1, create(api) {
        api.instructions.add({ kind: "text", text: "host-text" });
        api.tools.register({ name: "shared_tool", description: "d", parameters: { type: "object" }, permission: "read", execute: async () => ({ content: "" }) });
        api.ui.setStatus("h", "H");
        return { id: "host", dispose() { globalThis.__ext.order.push("dispose:host"); } };
      } };`,
    );
    ext(
      "a",
      `${tool("a_tool")} api.instructions.add({ kind: "text", text: "a-text" });
       api.events.on("turn_start", () => globalThis.__ext.events.push("a"));
       api.ui.setStatus("a", "A");
       try { ${tool("shared_tool")} } catch (e) { globalThis.__ext.events.push("dup:" + e.code); }
       ${tool("a_second")}`,
    );
    ext(
      "b",
      `api.instructions.add({ kind: "text", text: "b-text" });
       api.events.on("turn_start", () => globalThis.__ext.events.push("b"));
       api.ui.setStatus("b", "B");`,
    );
    h.deps.modes.print = async (runtime) => {
      await h.calls.assembly?.events.emit("turn_start", {});
      expect(runtime.extensions?.map((x) => [x.adapter.id, x.source.endsWith("a.mjs")])).toEqual([
        ["a", true],
        ["b", false],
      ]);
      expect([...(runtime.hostStatus?.() ?? [])]).toEqual([
        ["h", "H"],
        ["a", "A"],
        ["b", "B"],
      ]);
      expect(runtime.tools.list()).toEqual(
        expect.arrayContaining(["a_tool", "a_second", "shared_tool"]),
      );
      return 0;
    };
    expect(await run(["-p", "hi", "--host", "host.cjs"])).toBe(0);
    expect(g.__ext?.events).toEqual(["dup:tool_exists", "a", "b"]);
    const instructions = h.calls.assembly?.host.instructions.map((s) =>
      s.kind === "text" ? s.text : s.path,
    );
    expect(instructions).toEqual(["host-text", "a-text", "b-text"]);
    expect(h.calls.assembly?.host.handle?.adapter.id).toBe("host");
  });

  it("approvals.setBroker 第一个设置者胜出，其余忽略并 warning", async () => {
    ext("a", `api.approvals.setBroker({ ask: async () => "allow" });`);
    ext("b", `api.approvals.setBroker({ ask: async () => "deny" });`);
    h.deps.modes.print = async () => {
      const decision = await h.calls.assembly?.host
        .broker()
        ?.ask({} as never, new AbortController().signal);
      expect(decision).toBe("allow");
      return 0;
    };
    expect(await run(["-p", "hi"])).toBe(0);
    expect(h.err.join("")).toContain("approvals.setBroker");
  });

  it("cache.onWarmingDecision 跨模块最后注册的生效，注销后回落到前一个", async () => {
    ext("a", `api.cache.onWarmingDecision(() => "warm");`);
    ext("b", `globalThis.__ext.off = api.cache.onWarmingDecision(() => "stop");`);
    h.deps.modes.print = async () => {
      const decider = h.calls.assembly?.host.warmingDecider;
      expect(decider?.()?.({} as never)).toBe("stop");
      (g.__ext as unknown as { off: () => void }).off();
      expect(decider?.()?.({} as never)).toBe("warm");
      return 0;
    };
    expect(await run(["-p", "hi"])).toBe(0);
  });

  it("加载失败 / 版本不等 / create 抛错 / 未返回适配器：warning + 跳过，不退出，其余照常", async () => {
    ext("a-bad-syntax", "", "a-bad-syntax.mjs", "this is not valid js (");
    ext("b-version", "", "b-version.mjs", "");
    const versionPath = join(home.configDir, "extensions", "b-version.mjs");
    writeFileSync(
      versionPath,
      `export const hostApi = 2; export function create() { return { id: "x" }; }`,
    );
    setupExtensionTrust(home.configDir, versionPath);
    ext("c-throws", `throw new Error("boom");`);
    const nonePath = join(home.configDir, "extensions", "d-none.mjs");
    writeFileSync(
      nonePath,
      `export const hostApi = 1; export function create() { return undefined; }`,
    );
    setupExtensionTrust(home.configDir, nonePath);
    ext("e-ok", tool("e_tool"));
    let seen: string[] = [];
    h.deps.modes.print = async (runtime) => {
      seen = (runtime.extensions ?? []).map((x) => x.adapter.id);
      return 0;
    };
    expect(await run(["-p", "hi"])).toBe(0);
    expect(seen).toEqual(["e-ok"]);
    const stderr = h.err.join("");
    for (const name of ["a-bad-syntax", "b-version", "c-throws", "d-none"]) {
      expect(stderr).toContain(join(home.configDir, "extensions", `${name}.mjs`));
    }
    expect(stderr).toContain("boom");
  });

  it("按加载逆序 dispose：扩展在先，宿主适配器最后", async () => {
    home.write(
      "work/host.cjs",
      `module.exports = { hostApi: 1, create() { return { id: "host", dispose() { globalThis.__ext.order.push("dispose:host"); } }; } };`,
    );
    ext("a");
    ext("b");
    expect(await run(["-p", "hi", "--host", "host.cjs"])).toBe(0);
    expect(g.__ext?.order).toEqual(["dispose:b", "dispose:a", "dispose:host"]);
  });

  it("没有扩展：extensions 为空表，不产生 warning", async () => {
    let count = -1;
    h.deps.modes.print = async (runtime) => {
      count = runtime.extensions?.length ?? -1;
      return 0;
    };
    expect(await run(["-p", "hi"])).toBe(0);
    expect(count).toBe(0);
    expect(h.err.join("")).not.toContain("extensions");
  });

  it("profile extensions 排在用户级目录之后", async () => {
    ext("m-dir");
    const profileExt = home.write(
      "other/z-first-in-profile.mjs",
      `export const hostApi = 1; export function create() { return { id: "profile" }; }`,
    );
    setupExtensionTrust(home.configDir, profileExt);
    const profile = home.write("profile.json", { version: 1, extensions: [profileExt] });
    let ids: string[] = [];
    h.deps.modes.print = async (runtime) => {
      ids = (runtime.extensions ?? []).map((x) => x.adapter.id);
      return 0;
    };
    expect(await run(["-p", "hi", "--profile", profile])).toBe(0);
    expect(ids).toEqual(["m-dir", "profile"]);
  });
});
