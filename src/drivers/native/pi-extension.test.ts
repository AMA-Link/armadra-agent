import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PI_CONFIG_ENV,
  PI_EXTENSION_SOURCE,
  PI_GATE_TITLE,
  PI_REASON_TITLE,
  PI_STATUS_KEY,
  writePiExtension,
} from "./pi-extension.js";

type Handler = (event: Record<string, unknown>, ctx: FakeCtx) => Promise<unknown>;

interface FakeCtx {
  ui: {
    confirm: (title: string, message: string) => Promise<boolean>;
    editor: (title: string, prefill?: string) => Promise<string | undefined>;
    setStatus: (key: string, text: string | undefined) => void;
  };
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  delete process.env[PI_CONFIG_ENV];
  while (cleanup.length > 0) cleanup.pop()?.();
});

/** 把扩展源码当 ESM 加载，交给一个假的 pi API。 */
async function load(options: {
  config?: Record<string, unknown>;
  tools?: { name: string; annotations?: Record<string, unknown> }[];
  registerMcpServer?: (name: string, config: Record<string, unknown>) => void;
  noRegister?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "ama-ext-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "ext.mjs");
  writeFileSync(file, PI_EXTENSION_SOURCE);
  if (options.config !== undefined) {
    const configPath = join(dir, "bridge.json");
    writeFileSync(configPath, JSON.stringify(options.config));
    process.env[PI_CONFIG_ENV] = configPath;
  }
  const handlers = new Map<string, Handler>();
  const registered: [string, Record<string, unknown>][] = [];
  const pi: Record<string, unknown> = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    getAllTools: () => options.tools ?? [],
    ...(options.noRegister === true
      ? {}
      : {
          registerMcpServer: (name: string, config: Record<string, unknown>) => {
            options.registerMcpServer?.(name, config);
            registered.push([name, config]);
          },
        }),
  };
  const mod = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void };
  mod.default(pi);
  const ui = {
    confirms: [] as [string, string][],
    editors: [] as [string, string | undefined][],
    statuses: [] as [string, string | undefined][],
  };
  const ctx = (answers: { confirm?: boolean; reason?: string | undefined }): FakeCtx => ({
    ui: {
      confirm: async (title, message) => {
        ui.confirms.push([title, message]);
        return answers.confirm ?? false;
      },
      editor: async (title, prefill) => {
        ui.editors.push([title, prefill]);
        return answers.reason;
      },
      setStatus: (key, text) => void ui.statuses.push([key, text]),
    },
  });
  return { handlers, registered, ui, ctx };
}

describe("ama 的 pi 扩展", () => {
  it("MCP 透传：bridge.json 里的每个服务器以 exposure=direct 注册；没有环境变量时什么也不注册", async () => {
    const withConfig = await load({
      config: {
        mcpServers: {
          armadra: { command: "/bin/x", args: ["a"], env: { K: "v" } },
          remote: { url: "https://m.example/mcp", headers: { A: "b" } },
        },
      },
    });
    expect(withConfig.registered).toEqual([
      ["armadra", { command: "/bin/x", args: ["a"], env: { K: "v" }, exposure: "direct" }],
      ["remote", { url: "https://m.example/mcp", headers: { A: "b" }, exposure: "direct" }],
    ]);
    delete process.env[PI_CONFIG_ENV];
    const none = await load({});
    expect(none.registered).toEqual([]);
  });

  it("注册失败不让扩展加载失败：记进能力报告的 mcpFailures；旧版没有 registerMcpServer 时跳过", async () => {
    const failing = await load({
      config: { mcpServers: { bad: { command: "x" } } },
      registerMcpServer: () => {
        throw new Error("invalid config");
      },
      tools: [{ name: "bash" }, { name: "todo" }],
    });
    await failing.handlers.get("session_start")?.({}, failing.ctx({}));
    expect(failing.ui.statuses).toEqual([
      [
        PI_STATUS_KEY,
        JSON.stringify({ tools: ["bash", "todo"], mcpFailures: ["bad: invalid config"] }),
      ],
    ]);
    const old = await load({ config: { mcpServers: { s: { command: "x" } } }, noRegister: true });
    expect(old.registered).toEqual([]);
  });

  it("只读内置工具直接放行，不经对话框", async () => {
    const t = await load({});
    for (const tool of ["read", "grep", "find", "ls"])
      expect(await t.handlers.get("tool_call")?.({ toolName: tool }, t.ctx({}))).toBeUndefined();
    expect(t.ui.confirms).toEqual([]);
  });

  it("其它工具：confirm 带固定标题与 JSON 正文（readOnly 取自 annotations）；批准则放行", async () => {
    const t = await load({
      tools: [
        { name: "mcp__s__peek", annotations: { readOnlyHint: true } },
        { name: "mcp__s__poke", annotations: { readOnlyHint: false } },
      ],
    });
    const handler = t.handlers.get("tool_call")!;
    expect(
      await handler(
        { toolName: "mcp__s__peek", toolCallId: "c1", input: { q: 1 }, parentToolCallId: "p" },
        t.ctx({ confirm: true }),
      ),
    ).toBeUndefined();
    await handler(
      { toolName: "bash", toolCallId: "c2", input: { command: "ls" } },
      t.ctx({ confirm: true }),
    );
    expect(t.ui.confirms.map(([title]) => title)).toEqual([PI_GATE_TITLE, PI_GATE_TITLE]);
    expect(JSON.parse(t.ui.confirms[0]![1])).toEqual({
      id: "c1",
      tool: "mcp__s__peek",
      input: { q: 1 },
      readOnly: true,
      parent: "p",
    });
    expect(JSON.parse(t.ui.confirms[1]![1])).toMatchObject({ id: "c2", readOnly: false });
    expect(t.ui.editors).toEqual([]);
  });

  it("拒绝：用 editor 对话框取理由回给模型，取不到用默认句", async () => {
    const t = await load({});
    const handler = t.handlers.get("tool_call")!;
    expect(
      await handler(
        { toolName: "write", toolCallId: "w1", input: {} },
        t.ctx({ confirm: false, reason: "plan mode: read-only" }),
      ),
    ).toEqual({ block: true, reason: "plan mode: read-only" });
    expect(t.ui.editors).toEqual([[PI_REASON_TITLE, "w1"]]);
    expect(
      await handler({ toolName: "write", toolCallId: "w2", input: {} }, t.ctx({ confirm: false })),
    ).toEqual({ block: true, reason: "write was not approved by the user" });
  });

  it("文件写在私有临时目录（0600）、整目录可清理；源码固定（不含时间与随机数）", () => {
    const files = writePiExtension({ mcpServers: { s: { command: "x" } } });
    expect(files.configPath).toBeDefined();
    if (process.platform !== "win32") {
      expect(statSync(files.path).mode & 0o777).toBe(0o600);
      expect(statSync(files.configPath!).mode & 0o777).toBe(0o600);
    }
    files.dispose();
    expect(() => statSync(files.path)).toThrow();
    const plain = writePiExtension();
    expect(plain.configPath).toBeUndefined();
    plain.dispose();
    expect(PI_EXTENSION_SOURCE).not.toMatch(/Date\.now|Math\.random|randomUUID/);
  });
});
