import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverWorkflows,
  userWorkflowDir,
  workflowFileHash,
  workflowSources,
  workflowTargetPath,
} from "./discover.js";

const doc = (title: string): string =>
  `---\nversion: 2\ntitle: ${title}\nroles:\n  - id: a\n    agentId: ama\nsteps:\n  - id: s1\n    kind: prompt\n    role: a\n    prompt: go\n---\n`;

let root: string;
let cwd: string;
let configDir: string;
let extra: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ama-wf-disc-"));
  cwd = join(root, "proj");
  configDir = join(root, "cfg");
  extra = join(root, "extra");
  for (const d of [join(cwd, ".ama", "workflows"), userWorkflowDir(configDir), extra])
    mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("工作流发现", () => {
  it("来源顺序：config dirs → 用户级 → 项目级（需信任）", () => {
    const sources = workflowSources({ cwd, configDir, configDirs: [extra] });
    expect(sources).toEqual([
      { dir: extra, scope: "config", requiresTrust: false },
      { dir: join(configDir, "workflows"), scope: "user", requiresTrust: false },
      { dir: join(cwd, ".ama", "workflows"), scope: "project", requiresTrust: true },
    ]);
  });

  it("同 id 先到先得并 warning；按名排序；只看直接下层 *.md", () => {
    writeFileSync(join(extra, "b.md"), doc("extra-b"));
    writeFileSync(join(extra, "a.md"), doc("extra-a"));
    writeFileSync(join(extra, "note.txt"), "x");
    mkdirSync(join(extra, "sub"));
    writeFileSync(join(extra, "sub", "c.md"), doc("nested"));
    writeFileSync(join(userWorkflowDir(configDir), "a.md"), doc("user-a"));
    writeFileSync(join(cwd, ".ama", "workflows", "p.md"), doc("proj-p"));
    const r = discoverWorkflows(workflowSources({ cwd, configDir, configDirs: [extra] }), {
      trusted: true,
    });
    expect(r.workflows.map((w) => `${w.id}:${w.scope}`)).toEqual([
      "a:config",
      "b:config",
      "p:project",
    ]);
    expect(r.workflows[0]!.workflow.title).toBe("extra-a");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('workflow "a" already defined');
    expect(r.summaries.map((s) => s.id)).toEqual(["a", "b", "p"]);
    expect(r.summaries[0]).toMatchObject({ valid: true, title: "extra-a", roles: 1, steps: 1 });
  });

  it("未信任：跳过项目级并记入 skippedUntrusted；目录不存在不报", () => {
    writeFileSync(join(cwd, ".ama", "workflows", "p.md"), doc("proj"));
    writeFileSync(join(userWorkflowDir(configDir), "u.md"), doc("user"));
    const r = discoverWorkflows(
      workflowSources({ cwd, configDir, configDirs: [join(root, "missing")] }),
      { trusted: false },
    );
    expect(r.workflows.map((w) => w.id)).toEqual(["u"]);
    expect(r.skippedUntrusted).toEqual([join(cwd, ".ama", "workflows")]);
  });

  it("无效文件进 summaries（valid:false + error），不进 workflows；非法 id 同样", () => {
    writeFileSync(join(userWorkflowDir(configDir), "bad.md"), "no frontmatter");
    writeFileSync(join(userWorkflowDir(configDir), "1bad.md"), doc("x"));
    writeFileSync(join(userWorkflowDir(configDir), "ok.md"), doc("ok"));
    const r = discoverWorkflows(workflowSources({ cwd, configDir }), { trusted: true });
    expect(r.workflows.map((w) => w.id)).toEqual(["ok"]);
    const bad = r.summaries.find((s) => s.id === "bad");
    expect(bad).toMatchObject({ valid: false, scope: "user" });
    expect(bad?.error).toContain("frontmatter");
    expect(r.summaries.find((s) => s.id === "1bad")?.error).toContain("invalid workflow id");
  });

  it("hash 是文件全文 sha256（hex）", () => {
    const text = doc("h");
    writeFileSync(join(userWorkflowDir(configDir), "h.md"), text);
    const r = discoverWorkflows(workflowSources({ cwd, configDir }), { trusted: true });
    expect(r.workflows[0]!.hash).toBe(workflowFileHash(text));
    expect(workflowFileHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("保存路径：project / user，非法 id 抛错", () => {
    expect(workflowTargetPath("project", "x", { cwd, configDir })).toBe(
      join(cwd, ".ama", "workflows", "x.md"),
    );
    expect(workflowTargetPath("user", "x", { cwd, configDir })).toBe(
      join(configDir, "workflows", "x.md"),
    );
    expect(() => workflowTargetPath("user", "../x", { cwd, configDir })).toThrow(
      /Invalid workflow id/,
    );
  });
});
