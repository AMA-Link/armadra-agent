import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, makeToolContext } from "../../test/helpers/tool-context.js";
import { createHarness } from "../agent/testing/harness.js";
import { PermissionPipeline } from "../permissions/pipeline.js";
import { previewAction } from "../permissions/preview.js";
import type { ApprovalRequest } from "../permissions/types.js";
import { parseWorkflowFile } from "../workflows/file.js";
import { createWorkflowSaveTool } from "./workflow-save.js";
import { builtinTools } from "./registry.js";

const WF = {
  version: 2,
  title: "Demo",
  roles: [{ id: "a", agentId: "ama" }],
  steps: [{ id: "s1", kind: "prompt", role: "a", prompt: "do it" }],
};

let tmp: { dir: string; cleanup(): void };
let cfg: { dir: string; cleanup(): void };
beforeEach(() => {
  tmp = makeTmpDir();
  cfg = makeTmpDir();
});
afterEach(() => {
  tmp.cleanup();
  cfg.cleanup();
});

describe("workflow_save 工具", () => {
  const tool = () => createWorkflowSaveTool({ configDir: () => cfg.dir });

  it("声明 alwaysAsk、permission write，且是内置工具", () => {
    const t = tool();
    expect(t.annotations).toEqual({ alwaysAsk: true });
    expect(t.permission).toBe("write");
    expect(builtinTools().map((b) => b.name)).toContain("workflow_save");
  });

  it("保存到项目级，内容可被解析器读回", async () => {
    const r = await tool().execute({ id: "demo", workflow: WF }, makeToolContext(tmp.dir));
    const path = join(tmp.dir, ".ama", "workflows", "demo.md");
    expect(r).toMatchObject({ content: `Saved workflow demo to ${path}.` });
    expect(parseWorkflowFile(readFileSync(path, "utf8")).workflow?.title).toBe("Demo");
  });

  it("scope user 写进配置目录", async () => {
    const r = await tool().execute(
      { id: "demo", scope: "user", workflow: WF },
      makeToolContext(tmp.dir),
    );
    expect(r.isError).toBeUndefined();
    expect(existsSync(join(cfg.dir, "workflows", "demo.md"))).toBe(true);
    expect(existsSync(join(tmp.dir, ".ama"))).toBe(false);
  });

  it("不覆盖已存在文件；overwrite: true 才覆盖", async () => {
    const path = join(tmp.dir, ".ama", "workflows", "demo.md");
    mkdirSync(join(tmp.dir, ".ama", "workflows"), { recursive: true });
    writeFileSync(path, "keep");
    const ctx = makeToolContext(tmp.dir);
    const denied = await tool().execute({ id: "demo", workflow: WF }, ctx);
    expect(denied).toMatchObject({
      isError: true,
      content: `${path} already exists; pass overwrite: true or another id.`,
    });
    expect(readFileSync(path, "utf8")).toBe("keep");
    const ok = await tool().execute({ id: "demo", workflow: WF, overwrite: true }, ctx);
    expect(ok.isError).toBeUndefined();
    expect(readFileSync(path, "utf8")).toContain("title: Demo");
  });

  it("无效工作流 → Invalid workflow: + 每条一行；非法 id 报错且不写文件", async () => {
    const ctx = makeToolContext(tmp.dir);
    const bad = await tool().execute({ id: "demo", workflow: { version: 2 } }, ctx);
    expect(bad.isError).toBe(true);
    expect(String(bad.content).startsWith("Invalid workflow:\n")).toBe(true);
    const id = await tool().execute({ id: "../evil", workflow: WF }, ctx);
    expect(id.isError).toBe(true);
    expect(existsSync(join(tmp.dir, ".ama"))).toBe(false);
  });
});

describe("workflow_save 预览", () => {
  const req = (input: unknown): ApprovalRequest =>
    ({ requestId: "r", toolName: "workflow_save", input, reason: "mode" }) as ApprovalRequest;

  it("含目标路径与 YAML；新建 / 已存在不覆盖 / 覆盖", () => {
    const opts = { cwd: tmp.dir, configDir: cfg.dir };
    const fresh = previewAction(req({ id: "demo", workflow: WF }), opts);
    expect(fresh.kind).toBe("write");
    // 项目级预览路径经 displayPath，一律 POSIX 写法（Windows 也是）
    expect(fresh.affected).toEqual([{ path: ".ama/workflows/demo.md", exists: false }]);
    expect(fresh.lines.join("\n")).toContain("title: Demo");
    expect(fresh.lines).toContain("version: 2");

    mkdirSync(join(tmp.dir, ".ama", "workflows"), { recursive: true });
    writeFileSync(join(tmp.dir, ".ama", "workflows", "demo.md"), "old");
    const exists = previewAction(req({ id: "demo", workflow: WF }), opts);
    expect(exists.severity).toBe("warn");
    expect(exists.lines[0]).toContain("不会覆盖");
    const over = previewAction(req({ id: "demo", workflow: WF, overwrite: true }), opts);
    expect(over.lines[0]).toContain("覆盖");
    expect(over.lines[0]).not.toContain("不会");

    const user = previewAction(req({ id: "demo", scope: "user", workflow: WF }), opts);
    expect(user.affected?.[0]?.path).toBe(
      join(realpathSync(cfg.dir), "workflows", "demo.md"), // 预览显示解析后的真实路径
    );
  });

  it("YAML 只列前 40 行并注明余下行数；无效工作流给出问题", () => {
    const steps = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      kind: "prompt",
      role: "a",
      prompt: `p${i}`,
    }));
    const long = previewAction(req({ id: "big", workflow: { ...WF, steps } }), {
      cwd: tmp.dir,
      configDir: cfg.dir,
    });
    expect(long.lines.length).toBe(1 + 40 + 1);
    expect(long.lines.at(-1)).toMatch(/^… 另 \d+ 行$/);
    const bad = previewAction(req({ id: "x", workflow: {} }), { cwd: tmp.dir, configDir: cfg.dir });
    expect(bad.lines[0]).toContain("无效");
  });
});

describe("workflow_save 防符号链接", () => {
  const tool = () => createWorkflowSaveTool({ configDir: () => cfg.dir });
  const link = (target: string, path: string) => {
    try {
      symlinkSync(target, path, "dir");
      return true;
    } catch {
      return false; // 无权限创建符号链接的平台跳过
    }
  };

  it(".ama 是指向外部的符号链接：拒绝，外部目录里什么也不写", async () => {
    const outside = makeTmpDir();
    try {
      if (!link(outside.dir, join(tmp.dir, ".ama"))) return;
      const r = await tool().execute({ id: "demo", workflow: WF }, makeToolContext(tmp.dir));
      expect(r.isError).toBe(true);
      expect(String(r.content)).toContain("symbolic link");
      expect(readdirSync(outside.dir)).toEqual([]);
    } finally {
      outside.cleanup();
    }
  });

  it("目标文件是符号链接：overwrite 也拒绝，链接指向的文件不变", async () => {
    const outside = makeTmpDir();
    try {
      mkdirSync(join(tmp.dir, ".ama", "workflows"), { recursive: true });
      const victim = join(outside.dir, "victim.md");
      writeFileSync(victim, "keep");
      try {
        symlinkSync(victim, join(tmp.dir, ".ama", "workflows", "demo.md"), "file");
      } catch {
        return;
      }
      const r = await tool().execute(
        { id: "demo", workflow: WF, overwrite: true },
        makeToolContext(tmp.dir),
      );
      expect(r.isError).toBe(true);
      expect(readFileSync(victim, "utf8")).toBe("keep");
    } finally {
      outside.cleanup();
    }
  });

  it("预览显示解析后的真实路径", () => {
    const outside = makeTmpDir();
    try {
      mkdirSync(join(tmp.dir, ".ama"), { recursive: true });
      if (!link(outside.dir, join(tmp.dir, ".ama", "workflows"))) return;
      const req = {
        requestId: "r",
        toolName: "workflow_save",
        input: { id: "demo", workflow: WF },
        reason: "mode",
      } as ApprovalRequest;
      const p = previewAction(req, { cwd: tmp.dir, configDir: cfg.dir });
      expect(JSON.stringify(p)).toContain("demo.md");
      expect(JSON.stringify(p)).not.toContain(".ama/workflows/demo.md");
    } finally {
      outside.cleanup();
    }
  });
});

describe("workflow_save 经会话门控", () => {
  it("full-auto 下也会向人询问，预览带路径与 YAML；拒绝则不写文件", async () => {
    const asked: ApprovalRequest[] = [];
    const h = createHarness({
      cwd: tmp.dir,
      tools: [tool0(cfg.dir)],
      permission: new PermissionPipeline({ mode: "full-auto", rules: [], cwd: tmp.dir }),
      brokers: [{ ask: async (r) => (asked.push(r), "deny") }],
      script: [
        { toolCalls: [{ name: "workflow_save", args: { id: "demo", workflow: WF } }] },
        { text: "done" },
      ],
    });
    await h.session.prompt("go");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.preview?.lines.join("\n")).toContain("title: Demo");
    expect(existsSync(join(tmp.dir, ".ama"))).toBe(false);
  });
});

function tool0(configDir: string) {
  return createWorkflowSaveTool({ configDir: () => configDir });
}
