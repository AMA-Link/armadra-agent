import { describe, expect, it } from "vitest";
import {
  STEP_OUTPUT_MAX_CHARS,
  contractBlock,
  fixMessage,
  recollectMessage,
  stepOutputBlock,
  verifyInstruction,
} from "./step-prompt.js";

describe("contractBlock", () => {
  it("writes text and the owned globs", () => {
    expect(contractBlock({ text: "API: f()", owns: { a: ["src/a/**", "x.ts"] } }, "a")).toBe(
      "<contract>\nAPI: f()\nFiles you own (edit only these): src/a/**, x.ts\n</contract>",
    );
  });
  it("omits the missing parts", () => {
    expect(contractBlock({ text: "T" }, "a")).toBe("<contract>\nT\n</contract>");
    expect(contractBlock({ owns: { a: ["g"] } }, "a")).toBe(
      "<contract>\nFiles you own (edit only these): g\n</contract>",
    );
    expect(contractBlock({ text: "T", owns: { b: ["g"] } }, "a")).not.toContain("Files you own");
  });
  it("returns an empty string without text and owns", () => {
    expect(contractBlock({}, "a")).toBe("");
    expect(contractBlock({ text: "  ", owns: { a: [] } }, "a")).toBe("");
  });
});

describe("stepOutputBlock", () => {
  it("wraps short text unchanged", () => {
    expect(stepOutputBlock("s1", "dev", "done")).toBe(
      '<step-output step="s1" role="dev">\ndone\n</step-output>',
    );
  });
  it("truncates head and tail and names the full file", () => {
    const text = "H".repeat(5000) + "M".repeat(2000) + "T".repeat(5000);
    const block = stepOutputBlock("s1", "dev", text, "/o/out.md");
    expect(block).toContain("H".repeat(100));
    expect(block).toContain("T".repeat(100));
    expect(block).not.toContain("M");
    expect(block).toContain("\n(truncated; full output: /o/out.md)\n</step-output>");
    expect(block.length).toBeLessThan(STEP_OUTPUT_MAX_CHARS + 200);
  });
  it("marks truncation without a file", () => {
    const block = stepOutputBlock("s", "r", "x".repeat(STEP_OUTPUT_MAX_CHARS + 1));
    expect(block).toContain("\n(truncated)\n");
  });
  it("keeps text of exactly the limit", () => {
    expect(stepOutputBlock("s", "r", "x".repeat(STEP_OUTPUT_MAX_CHARS))).not.toContain("truncated");
  });
});

describe("verifyInstruction", () => {
  it("lists commands, checklist and the role tags", () => {
    expect(
      verifyInstruction({ commands: ["pnpm test", "pnpm lint"], checklist: ["docs updated"] }, [
        "a",
        "b",
      ]),
    ).toBe(
      "Before you finish, verify the result:\n" +
        "- run `pnpm test` and make sure it succeeds\n" +
        "- run `pnpm lint` and make sure it succeeds\n" +
        "- docs updated\n" +
        "Then call report: state ready only if every check passed; otherwise state failed and, in the " +
        "summary, start each problem with the role it belongs to, one of [a] [b].",
    );
  });
  it("accepts null lists", () => {
    expect(verifyInstruction({ commands: null, checklist: null }, ["a"])).toContain("one of [a].");
  });
});

describe("fix and recollect messages", () => {
  it("fixMessage", () => {
    expect(fixMessage("c", 1, 2, "[a] broken")).toBe(
      "The collect step c found problems in your part (attempt 1 of 2):\n[a] broken\n" +
        "Fix them, then end with your report.",
    );
  });
  it("recollectMessage", () => {
    expect(recollectMessage(2, 3)).toBe(
      "The problems were sent back and fixed (attempt 2 of 3). Collect again from the updated " +
        "outputs below and verify again.",
    );
  });
});
