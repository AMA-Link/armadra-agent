import { describe, expect, it } from "vitest";
import {
  checkRenderedPrompts,
  normalizeWorkflow,
  promptLimitOf,
  renderWorkflowPrompt,
  resolveWorkflowParams,
} from "./render.js";
import type { CollectStep, PromptStep, WorkflowDocument } from "./types.js";

function doc(extra: Partial<WorkflowDocument> = {}): WorkflowDocument {
  return {
    version: 2,
    title: "t",
    params: [
      { name: "repo", type: "path" },
      { name: "scope", default: "src" },
    ],
    roles: [
      { id: "a", agentId: "ama" },
      { id: "b", agentId: "ama" },
    ],
    steps: [
      { id: "p", kind: "prompt", role: "a", prompt: "Review {{scope}} in {{repo}}" },
      { id: "q", kind: "prompt", role: "b", prompt: "plain" },
      { id: "c", kind: "collect", role: "a", from: ["p"], after: ["p"], prompt: "gather" },
    ],
    ...extra,
  };
}

describe("normalizeWorkflow", () => {
  it("fills defaults without touching the document", () => {
    const w = doc({
      links: [{ from: "a", to: "b" }],
      steps: [
        { id: "p", kind: "prompt", role: "a", prompt: "x" },
        {
          id: "c",
          kind: "collect",
          role: "a",
          from: ["p"],
          after: ["p"],
          prompt: "g",
          verify: { commands: ["t"] },
        },
      ],
    });
    const n = normalizeWorkflow(w);
    expect(n.document).toBe(w);
    expect(n.params.map((p) => p.type)).toEqual(["path", "string"]);
    expect(n.links).toEqual([{ from: "a", to: "b", role: "peer" }]);
    expect(n.after.get("p")).toEqual([]);
    expect(n.after.get("c")).toEqual(["p"]);
    expect(n.maxRetries.get("c")).toBe(2);
    expect(n.maxRetries.has("p")).toBe(false);
    expect(w.links![0]).not.toHaveProperty("role");
  });
  it("keeps an explicit maxRetries of 0", () => {
    const w = doc({
      steps: [
        { id: "p", kind: "prompt", role: "a", prompt: "x" },
        {
          id: "c",
          kind: "collect",
          role: "a",
          from: ["p"],
          after: ["p"],
          prompt: "g",
          verify: { checklist: ["ok"] },
          maxRetries: 0,
        },
      ],
    });
    expect(normalizeWorkflow(w).maxRetries.get("c")).toBe(0);
  });
});

describe("resolveWorkflowParams", () => {
  it("fills defaults and requires the rest", () => {
    expect(resolveWorkflowParams(doc(), { repo: "." })).toEqual({
      ok: true,
      params: { repo: ".", scope: "src" },
    });
    expect(resolveWorkflowParams(doc(), {})).toMatchObject({ ok: false, code: "missing_param" });
    expect(resolveWorkflowParams(doc(), { repo: "" })).toMatchObject({ code: "missing_param" });
  });
  it("rejects unknown, non-string and long values", () => {
    expect(resolveWorkflowParams(doc(), { repo: ".", x: "1" })).toMatchObject({
      ok: false,
      code: "invalid_param",
    });
    expect(resolveWorkflowParams(doc(), { repo: 3 })).toMatchObject({ code: "invalid_param" });
    expect(resolveWorkflowParams(doc(), { repo: "x".repeat(2001) })).toMatchObject({
      code: "invalid_param",
      message: "Parameter repo is longer than 2000 characters.",
    });
    expect(resolveWorkflowParams(doc(), { repo: "汉".repeat(2000) }).ok).toBe(true);
  });
});

describe("renderWorkflowPrompt", () => {
  it("substitutes declared names and leaves the rest", () => {
    expect(renderWorkflowPrompt("{{a}} {{ b }} {{c}} $&", { a: "1", b: "$&" })).toBe(
      "1 $& {{c}} $&",
    );
    expect(renderWorkflowPrompt("{{__proto__}} {{constructor}}", {})).toBe(
      "{{__proto__}} {{constructor}}",
    );
  });
});

describe("prompt limits", () => {
  const step = (w: WorkflowDocument, id: string) =>
    w.steps.find((s) => s.id === id) as PromptStep | CollectStep;
  it("gives 1800 to collect and contracted prompt steps", () => {
    const plain = doc();
    expect(promptLimitOf(plain, step(plain, "p"))).toBe(2000);
    expect(promptLimitOf(plain, step(plain, "c"))).toBe(1800);
    const withText = doc({ contract: { text: "x" } });
    expect(promptLimitOf(withText, step(withText, "q"))).toBe(1800);
    const withOwns = doc({ contract: { owns: { a: ["src/"], b: [] } } });
    expect(promptLimitOf(withOwns, step(withOwns, "p"))).toBe(1800);
    expect(promptLimitOf(withOwns, step(withOwns, "q"))).toBe(2000);
    expect(promptLimitOf(doc({ contract: { text: "" } }), step(plain, "q"))).toBe(2000);
  });
  it("checks rendered prompts by code point", () => {
    const params = { repo: ".", scope: "x".repeat(1980) };
    expect(checkRenderedPrompts(doc(), params)).toBeUndefined();
    const owns = doc({ contract: { owns: { a: ["src/"] } } });
    expect(checkRenderedPrompts(owns, { repo: ".", scope: "x".repeat(1780) })).toBeUndefined();
    expect(checkRenderedPrompts(owns, params)).toEqual({ stepId: "p", limit: 1800 });
    const w = doc({
      steps: [
        { id: "p", kind: "prompt", role: "a", prompt: "x" },
        { id: "g", kind: "gate", label: "y".repeat(5000) },
        {
          id: "c",
          kind: "collect",
          role: "a",
          from: ["p"],
          after: ["p"],
          prompt: "汇".repeat(1801),
        },
      ],
    });
    expect(checkRenderedPrompts(w, {})).toEqual({ stepId: "c", limit: 1800 });
  });
});
