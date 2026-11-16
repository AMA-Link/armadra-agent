/**
 * #304：扩展激活失败（create 抛错 / 超时 / 未返回适配器）时撤回它已注册的全部内容；
 * 撤回后（含超时后迟到）的注册被忽略并记 warning；系统提示与工具表回到没有该扩展时的样子。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTmpHome } from "../../test/helpers/tmp-home.js";
import { getLocale, setLocale } from "../i18n/index.js";
import { createToolRegistry } from "../tools/registry.js";
import {
  AgentEventBus,
  createHostApi,
  createHostContext,
  mergedHostStatus,
  type HostApiDeps,
} from "./api-impl.js";
import { activateExtensions } from "./extensions.js";
import { HostResourceRegistry } from "./resources.js";

const tmp = createTmpHome("ama-revoke-");
let previous: ReturnType<typeof getLocale>;
beforeAll(() => {
  previous = getLocale();
  setLocale("en");
});
afterAll(() => {
  setLocale(previous);
  tmp.cleanup();
});

/** 每类注册各来一次；`tail` 是注册完之后 create 的结尾。 */
const REGISTER_ALL = `
  api.tools.register({ name: "ext_tool", description: "d", parameters: { type: "object" }, permission: "read", execute: async () => ({ content: "" }) });
  api.tools.disable("grep");
  api.instructions.add({ kind: "text", text: "ext-text" });
  api.events.on("turn_start", () => undefined);
  api.commands.register({ name: "ext-cmd", description: "d", run: () => undefined });
  api.ui.setStatus("ext", "X");
  api.cache.onWarmingDecision(() => "warm");
  api.approvals.setBroker({ ask: async () => "allow" });
  api.runners.provide({ id: "ext-runner", description: "d", start: async () => { throw new Error("x"); } });
  api.runners.onDone(() => undefined);
  api.resources.register({ scheme: "extres", describe: "d", read: async () => ({ content: "" }) });
`;

const ENDINGS = {
  throws: `${REGISTER_ALL} throw new Error("boom");`,
  timeout: `${REGISTER_ALL} globalThis.__late = api; await new Promise((r) => setTimeout(r, 250)); return { id: "late" };`,
  undefined: `${REGISTER_ALL} return undefined;`,
} as const;

let counter = 0;
function writeExt(body: string): string {
  const dir = join(tmp.root, "exts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `ext-${counter++}.mjs`);
  writeFileSync(
    path,
    `export const hostApi = 1;\nexport async function create(api) {\n${body}\n}\n`,
  );
  return path;
}

function setup() {
  const tools = createToolRegistry();
  const bus = new AgentEventBus();
  const resources = new HostResourceRegistry();
  const warnings: string[] = [];
  const statusCalls: [string, string | undefined][] = [];
  const deps: HostApiDeps = {
    mode: "print",
    session: { id: () => "s", file: () => undefined, cwd: () => "/w", model: () => undefined },
    tools,
    bus,
    sendUser: async () => "queued",
    onStatus: (key, text) => void statusCalls.push([key, text]),
    stderr: (text) => void warnings.push(text),
    resources,
  };
  const context = createHostContext();
  const table = (): string =>
    JSON.stringify(tools.active().map((t) => [t.name, t.description, t.parameters]));
  return { tools, bus, resources, warnings, statusCalls, deps, context, table };
}

describe("扩展激活失败时撤回（#304）", () => {
  for (const [kind, body] of Object.entries(ENDINGS)) {
    it(`${kind}：每类注册都被撤回，工具表与指令回到没有该扩展时`, async () => {
      const s = setup();
      const baselineTable = s.table();
      const baselineTools = [...s.tools.list()];
      const out = await activateExtensions({
        paths: [writeExt(body)],
        createBinding: () => createHostApi(s.deps, s.context),
        warn: () => undefined,
        timeoutMs: 60,
      });
      expect(out.handles).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      // 工具：注册的移除、禁用的恢复
      expect(s.tools.get("ext_tool")).toBeUndefined();
      expect(s.tools.isDisabled("grep")).toBe(false);
      expect(s.tools.list()).toEqual(baselineTools);
      expect(s.table()).toBe(baselineTable);
      // 事件订阅、命令、指令、状态、保温、broker、runner、资源
      expect(s.bus.listenerCount("turn_start")).toBe(0);
      expect(s.context.commands.list()).toEqual([]);
      expect(s.context.instructions).toEqual([]);
      expect([...mergedHostStatus(s.context)]).toEqual([]);
      expect(s.statusCalls).toEqual([
        ["ext", "X"],
        ["ext", undefined],
      ]);
      expect(s.context.warming).toEqual([]);
      expect(s.context.broker).toEqual({});
      expect(s.context.runners.list()).toEqual([]);
      expect(s.resources.schemes()).toEqual([]);
    });
  }

  it("超时后迟到的注册被忽略并记 warning", async () => {
    const s = setup();
    const g = globalThis as { __late?: import("./types.js").HostApi };
    await activateExtensions({
      paths: [writeExt(ENDINGS.timeout)],
      createBinding: () => createHostApi(s.deps, s.context),
      warn: () => undefined,
      timeoutMs: 40,
    });
    const api = g.__late!;
    expect(api).toBeDefined();
    api.tools.register({
      name: "late_tool",
      description: "d",
      parameters: { type: "object" },
      permission: "read",
      execute: async () => ({ content: "" }),
    });
    api.instructions.add({ kind: "text", text: "late" });
    api.events.on("turn_start", () => undefined);
    api.commands!.register({ name: "late-cmd", description: "d", run: () => undefined });
    api.ui.setStatus("late", "L");
    api.cache!.onWarmingDecision(() => "warm");
    api.approvals.setBroker({ ask: async () => "allow" });
    api.runners!.provide({ id: "late-runner", description: "d", start: async () => ({}) as never });
    api.runners!.onDone!(() => undefined);
    api.resources!.register({ scheme: "lateres", describe: "d", read: async () => ({}) as never });
    expect(s.tools.get("late_tool")).toBeUndefined();
    expect(s.context.instructions).toEqual([]);
    expect(s.bus.listenerCount("turn_start")).toBe(0);
    expect(s.context.commands.list()).toEqual([]);
    expect([...mergedHostStatus(s.context)]).toEqual([]);
    expect(s.context.warming).toEqual([]);
    expect(s.context.broker).toEqual({});
    expect(s.context.runners.list()).toEqual([]);
    expect(s.resources.schemes()).toEqual([]);
    const warned = s.warnings.join("");
    for (const what of ["tools.register", "runners.provide", "resources.register"]) {
      expect(warned).toContain(what);
    }
    await new Promise((r) => setTimeout(r, 250)); // 让悬挂的 create 收尾
  });

  it("失败的扩展不影响其它模块的注册；成功的扩展保留", async () => {
    const s = setup();
    const okTool = `api.tools.register({ name: "ok_tool", description: "d", parameters: { type: "object" }, permission: "read", execute: async () => ({ content: "" }) });
      api.instructions.add({ kind: "text", text: "ok" }); api.approvals.setBroker({ ask: async () => "allow" });
      return { id: "ok" };`;
    const out = await activateExtensions({
      paths: [
        writeExt(okTool),
        writeExt(ENDINGS.throws),
        writeExt(okTool.replace(/ok_tool/, "ok_tool2")),
      ],
      createBinding: () => createHostApi(s.deps, s.context),
      warn: () => undefined,
    });
    expect(out.handles.map((h) => h.adapter.id)).toEqual(["ok", "ok"]);
    expect(s.tools.get("ok_tool")).toBeDefined();
    expect(s.tools.get("ext_tool")).toBeUndefined();
    expect(s.context.instructions).toEqual([
      { kind: "text", text: "ok" },
      { kind: "text", text: "ok" },
    ]);
    expect(s.context.broker.value).toBeDefined(); // 第一个成功扩展占有的 broker 不受第二个失败扩展影响
  });

  it("revoke 幂等；broker 不是自己持有时不动别人的", () => {
    const s = setup();
    const a = createHostApi(s.deps, s.context);
    const b = createHostApi(s.deps, s.context);
    a.api.approvals.setBroker({ ask: async () => "allow" });
    b.api.approvals.setBroker({ ask: async () => "deny" }); // 被忽略
    b.revoke();
    b.revoke();
    expect(s.context.broker.value).toBeDefined();
    a.revoke();
    expect(s.context.broker).toEqual({});
  });

  it("revoke 只恢复自己新禁用的工具，别人先禁用的保持禁用", () => {
    const s = setup();
    s.tools.disable("ls");
    const a = createHostApi(s.deps, s.context);
    a.api.tools.disable("ls");
    a.api.tools.disable("glob");
    a.revoke();
    expect(s.tools.isDisabled("ls")).toBe(true);
    expect(s.tools.isDisabled("glob")).toBe(false);
  });
});
