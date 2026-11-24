import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatWorkflowFile, parseWorkflowFile } from "./file.js";
import { validateWorkflow } from "./validate.js";

const dir = new URL("../../test/fixtures/workflows/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, dir), "utf8");
const names = readdirSync(dir).filter((n) => n.endsWith(".md"));

const INVALID: Record<string, RegExp> = {
  "invalid-version-1.md": /version must be 2/,
  "invalid-cycle.md": /cycle: s1 -> s2 -> s1/,
  "invalid-unknown-field.md": /unknown field "tir"/,
  "invalid-collect-from.md": /"s2" must also be listed in after/,
  "invalid-owns-role.md": /"ghost" is not a role/,
  "invalid-owns-overlap.md": /a "src\/\*\*" overlaps b "src\/web\/"/,
  "invalid-glob.md": /invalid glob "\.\.\/outside"/,
  "invalid-retries-without-verify.md": /only allowed together with verify/,
  "invalid-description-key.md": /description belongs in the body/,
  "invalid-custom-suffix.md": /must be an agent id/,
};

describe("workflow fixtures", () => {
  it("covers every invalid fixture", () => {
    expect(names.filter((n) => n.startsWith("invalid-")).sort()).toEqual(
      Object.keys(INVALID).sort(),
    );
  });
  it.each(Object.entries(INVALID))("%s is refused", (name, expected) => {
    const r = parseWorkflowFile(read(name));
    expect(r.workflow).toBeUndefined();
    expect(r.issues.map((i) => i.message).join("\n")).toMatch(expected);
  });
  it.each(names.filter((n) => n.startsWith("valid-")))("%s parses and round-trips", (name) => {
    const text = read(name);
    const r = parseWorkflowFile(text);
    expect(r.issues).toEqual([]);
    const w = r.workflow!;
    expect(validateWorkflow(w).ok).toBe(true);
    const out = formatWorkflowFile(w);
    expect(parseWorkflowFile(out).workflow).toEqual(w);
    expect(formatWorkflowFile(parseWorkflowFile(out).workflow!)).toBe(out);
  });
});

describe("parseWorkflowFile", () => {
  it("takes the body as description, trimming blank edges", () => {
    const w = parseWorkflowFile(read("valid-full.md")).workflow!;
    expect(w.description).toBe(
      "For people: this workflow builds the API and the UI in parallel.\n\nIt is never sent to a model.",
    );
    expect(parseWorkflowFile(read("valid-minimal.md")).workflow).not.toHaveProperty("description");
  });
  it("does not fill defaults or rewrite globs", () => {
    const w = parseWorkflowFile(read("valid-full.md")).workflow!;
    expect(w.contract!.owns!.api).toEqual(["src/server/"]);
    expect(w.steps[0]).not.toHaveProperty("after");
    expect(w.params![0]).toEqual({ name: "feature", type: "text", label: "What to build" });
    const min = parseWorkflowFile(read("valid-minimal.md")).workflow!;
    expect(min).not.toHaveProperty("params");
    expect(min).not.toHaveProperty("links");
  });
  it("reports frontmatter problems", () => {
    expect(parseWorkflowFile("title: x").issues[0]!.message).toMatch(/must start with/);
    expect(parseWorkflowFile("---\ntitle: x\n").issues[0]!.message).toMatch(/not closed/);
    expect(parseWorkflowFile("---\n- a\n---\n").issues[0]!.message).toMatch(/mapping/);
    expect(parseWorkflowFile("---\na: [\n---\n").issues[0]!.message).toMatch(/line/);
    expect(parseWorkflowFile("").workflow).toBeUndefined();
  });
  it("accepts CRLF and surfaces warnings", () => {
    const text = read("valid-minimal.md").replace(/\n/g, "\r\n");
    expect(parseWorkflowFile(text).workflow?.title).toBe("One step");
    const shared = read("valid-armadra-fields.md")
      .replace("agentId: claude", "agentId: claude\n    worktree: w")
      .replace("agentId: codex", "agentId: codex\n    worktree: w");
    const r = parseWorkflowFile(shared);
    expect(r.workflow).toBeDefined();
    expect(r.issues.map((i) => i.severity)).toEqual(["warning"]);
  });
});

describe("formatWorkflowFile", () => {
  it("writes only the fields present, in the frozen order", () => {
    const text = formatWorkflowFile(parseWorkflowFile(read("valid-minimal.md")).workflow!);
    expect(text).toBe(
      "---\nversion: 2\ntitle: One step\nroles:\n  - id: a\n    agentId: ama\nsteps:\n  - id: only\n    kind: prompt\n    role: a\n    prompt: Do the thing.\n---\n",
    );
  });
  it("keeps globs verbatim and puts the description in the body", () => {
    const text = formatWorkflowFile(parseWorkflowFile(read("valid-full.md")).workflow!);
    expect(text).toContain("- src/server/\n");
    expect(text).not.toContain("src/server/**");
    expect(text).not.toMatch(/^description:/m);
    expect(text.endsWith("It is never sent to a model.\n")).toBe(true);
    expect(text.indexOf("params:")).toBeLessThan(text.indexOf("roles:"));
    expect(text.indexOf("contract:")).toBeLessThan(text.indexOf("steps:"));
  });
  it("omits null fields and empty params / links", () => {
    const text = formatWorkflowFile({
      version: 2,
      title: "t",
      description: null,
      params: [],
      links: [],
      roles: [{ id: "a", agentId: "ama", tier: null, model: null }],
      steps: [{ id: "s", kind: "prompt", role: "a", prompt: "p", after: null }],
    });
    expect(text).not.toMatch(/params|links|tier|model|after|description/);
    expect(parseWorkflowFile(text).issues).toEqual([]);
  });
  it("round-trips multiline and tricky strings", () => {
    const w = parseWorkflowFile(read("valid-full.md")).workflow!;
    const tricky = {
      ...w,
      title: "Plan: a # b",
      contract: { text: "line one\nline two\n  indented\n" },
    };
    const back = parseWorkflowFile(formatWorkflowFile(tricky)).workflow!;
    expect(back.title).toBe("Plan: a # b");
    expect(back.contract!.text).toBe("line one\nline two\n  indented\n");
  });
});
