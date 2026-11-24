import { describe, expect, it } from "vitest";
import { validateWorkflow } from "./validate.js";

type Raw = Record<string, any>;

/** 与 Armadra draft.test.ts 同口径的样本（version 2、无 unknown 字段）。 */
function sample(): Raw {
  return {
    version: 2,
    title: "Two-reviewer review",
    params: [
      { name: "repo", type: "path" },
      { name: "scopeA", type: "string" },
    ],
    roles: [
      { id: "reviewerA", agentId: "claude", permissionMode: "plan", model: null, worktree: null },
      { id: "reviewerB", agentId: "custom:reviewer" },
      { id: "lead", agentId: "codex", permissionMode: "default" },
    ],
    links: [{ from: "lead", to: "reviewerA" }],
    steps: [
      { id: "s1", kind: "prompt", role: "reviewerA", prompt: "Review {{scopeA}}", after: [] },
      { id: "s2", kind: "prompt", role: "reviewerB", prompt: "Review B" },
      {
        id: "s3",
        kind: "collect",
        role: "lead",
        from: ["s1", "s2"],
        prompt: "Summarize",
        after: ["s1", "s2"],
      },
      { id: "s4", kind: "gate", label: "Check before merging", after: ["s3"] },
    ],
    source: { boardId: "b", nodeIds: ["n"], proposedBy: "ama" },
  };
}

function errorsOf(raw: unknown): string[] {
  const r = validateWorkflow(raw);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
}
function refuses(mutate: (d: Raw) => void, expected: RegExp): void {
  const d = sample();
  mutate(d);
  expect(errorsOf(d).join("\n")).toMatch(expected);
}
const collectOf = (d: Raw): Raw => d.steps[2];

describe("validateWorkflow base rules", () => {
  it("accepts the sample and writes nothing back", () => {
    const r = validateWorkflow(sample());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.workflow).toEqual(sample());
    expect(r.workflow.links![0]).not.toHaveProperty("role");
    expect(r.workflow.steps[1]).not.toHaveProperty("after");
    expect(r.warnings).toEqual([]);
  });

  it("refuses non-objects, oversize drafts and a missing frame", () => {
    for (const bad of [null, [], "x", 3]) expect(validateWorkflow(bad).ok).toBe(false);
    refuses((d) => (d.description = "x".repeat(4000) + "y"), /description: must be at most 4000/);
    refuses((d) => (d.steps[0].prompt = "x".repeat(1999) + "yy"), /prompt: must be at most 2000/);
    refuses(
      (d) =>
        (d.params = Array.from({ length: 40 }, (_, i) => ({
          name: `p${i}`,
          default: "x".repeat(2000),
        }))),
      /params: has more than 32|larger than/,
    );
    refuses((d) => delete d.title, /title: is required/);
  });

  it("only accepts version 2", () => {
    for (const v of [0, 1, 3, "2", undefined]) {
      refuses((d) => (d.version = v), /version: version must be 2/);
    }
  });

  it("refuses unknown fields at every level", () => {
    refuses((d) => (d.extra = 1), /\$: unknown field "extra"/);
    refuses((d) => (d.roles[0].tir = "x"), /roles\[0\]: unknown field "tir"/);
    refuses((d) => (d.params[0].lable = "x"), /params\[0\]: unknown field "lable"/);
    refuses((d) => (d.links[0].kind = "x"), /links\[0\]: unknown field "kind"/);
    refuses((d) => (d.source.extra = 1), /source: unknown field "extra"/);
    refuses((d) => (d.steps[0].from = ["s2"]), /steps\[0\]: unknown field "from"/);
    refuses((d) => (d.steps[3].role = "lead"), /steps\[3\]: unknown field "role"/);
    refuses(
      (d) => (collectOf(d).verify = { commands: ["x"], more: 1 }),
      /verify: unknown field "more"/,
    );
    refuses((d) => (d.contract = { text: "x", more: 1 }), /contract: unknown field "more"/);
  });

  it("checks agent ids (acp: allowed here, custom: suffix 1-64)", () => {
    for (const id of [
      "gpt cli",
      "Claude",
      "custom:",
      "custom:" + "a".repeat(65),
      "custom:a\nb",
      "",
    ]) {
      refuses((d) => (d.roles[0].agentId = id), /agentId/);
    }
    for (const id of [
      "ama",
      "custom:" + "a".repeat(64),
      "custom:with space/ok",
      "acp:vendor/agent",
    ]) {
      const d = sample();
      d.roles[0].agentId = id;
      expect(validateWorkflow(d).ok, id).toBe(true);
    }
  });

  it("refuses cycles, dangling and self references", () => {
    refuses((d) => (d.steps[0].after = ["s4"]), /cycle: s1 -> s4 -> s3 -> s1/);
    refuses((d) => (d.steps[0].after = ["s1"]), /after\[0\]: a step cannot come after itself/);
    refuses((d) => (d.steps[1].after = ["s9"]), /after\[0\]: "s9" is not a step/);
    refuses((d) => (d.steps[0].role = "ghost"), /role: "ghost" is not a role/);
    refuses(
      (collect) => (collectOf(collect).after = ["s1"]),
      /from\[1\]: "s2" must also be listed in after/,
    );
    refuses((d) => (collectOf(d).from = []), /from: needs at least 1 item/);
    refuses((d) => (d.links = [{ from: "lead", to: "lead" }]), /connects a role to itself/);
    refuses((d) => (d.links = [{ from: "lead", to: "ghost" }]), /to: "ghost" is not a role/);
    refuses((d) => (d.links[0].role = "boss"), /links\[0\]\.role/);
  });

  it("refuses bad shapes and duplicates", () => {
    refuses((d) => (d.roles = []), /roles: needs at least 1 item/);
    refuses((d) => (d.steps = []), /steps: needs at least 1 item/);
    refuses((d) => (d.steps[0].kind = "loop"), /kind: must be one of prompt, collect, gate/);
    refuses((d) => (d.roles[0].permissionMode = "yolo"), /permissionMode/);
    refuses((d) => (d.roles[1].id = "reviewerA"), /roles: id "reviewerA" is duplicated/);
    refuses((d) => (d.steps[1].id = "s1"), /steps: id "s1" is duplicated/);
    refuses((d) => (d.params[1].name = "repo"), /params: name "repo" is duplicated/);
    refuses((d) => (d.params[0].type = "number"), /params\[0\]\.type/);
    refuses((d) => (d.params[0].name = "1x"), /params\[0\]\.name/);
    refuses((d) => (d.roles[0].id = "9bad"), /roles\[0\]\.id/);
    refuses(
      (d) => (d.roles = Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, agentId: "ama" }))),
      /roles: has more than 8/,
    );
    refuses((d) => (d.roles[0].model = "m".repeat(121)), /model: must be at most 120/);
    refuses((d) => (d.roles[0].tier = "ultra"), /tier: must be one of/);
    expect(
      validateWorkflow({ ...sample(), roles: [{ id: "a", agentId: "ama", tier: null }] }).ok,
    ).toBe(false);
  });

  it("keeps explicit nulls and counts code points", () => {
    const d = sample();
    d.roles[0].tier = null;
    d.title = "汉".repeat(160);
    const r = validateWorkflow(d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.workflow.roles[0]).toHaveProperty("tier", null);
    d.title = "汉".repeat(161);
    expect(validateWorkflow(d).ok).toBe(false);
  });

  it("collects several errors at once", () => {
    const d = sample();
    d.title = "";
    d.steps[0].role = "ghost";
    d.extra = 1;
    expect(errorsOf(d).length).toBeGreaterThanOrEqual(3);
  });
});

describe("validateWorkflow v2 fields", () => {
  const v2 = (): Raw => {
    const d = sample();
    d.roles[0].tier = "strong";
    collectOf(d).verify = { commands: ["pnpm test"], checklist: ["complete"] };
    collectOf(d).maxRetries = 1;
    d.description = "notes";
    d.contract = { text: "shared", owns: { reviewerA: ["src/a/"], lead: [] } };
    return d;
  };
  const refuseV2 = (mutate: (d: Raw) => void, expected: RegExp): void => {
    const d = v2();
    mutate(d);
    expect(errorsOf(d).join("\n")).toMatch(expected);
  };

  it("accepts a v2 document untouched, glob included", () => {
    const r = validateWorkflow(v2());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.workflow).toEqual(v2());
  });

  it("checks verify and maxRetries", () => {
    refuseV2((d) => (collectOf(d).verify = {}), /verify: needs at least one/);
    refuseV2(
      (d) => (collectOf(d).verify = { commands: [], checklist: [] }),
      /verify: needs at least one/,
    );
    refuseV2(
      (d) => (collectOf(d).verify = { commands: Array(5).fill("x") }),
      /commands: has more than 4/,
    );
    refuseV2(
      (d) => (collectOf(d).verify = { commands: ["x".repeat(301)] }),
      /commands\[0\]: must be at most 300/,
    );
    refuseV2(
      (d) => (collectOf(d).verify = { checklist: Array(17).fill("x") }),
      /checklist: has more than 16/,
    );
    refuseV2((d) => (collectOf(d).maxRetries = 4), /maxRetries: must be an integer from 0 to 3/);
    refuseV2((d) => (collectOf(d).maxRetries = 1.5), /maxRetries: must be an integer/);
    refuseV2((d) => delete collectOf(d).verify, /maxRetries: is only allowed together with verify/);
    const edge = v2();
    collectOf(edge).maxRetries = 0;
    expect(validateWorkflow(edge).ok).toBe(true);
    const full = v2();
    collectOf(full).verify = {
      commands: Array(4).fill("x".repeat(300)),
      checklist: Array(16).fill("x".repeat(300)),
    };
    expect(validateWorkflow(full).ok).toBe(true);
  });

  it("checks contract text, owns keys and sizes", () => {
    refuseV2((d) => (d.contract = {}), /contract: needs text or owns/);
    refuseV2(
      (d) => (d.contract = { text: "x".repeat(6001) }),
      /contract\.text: must be at most 6000/,
    );
    refuseV2(
      (d) => (d.contract = { owns: { ghost: ["a"] } }),
      /contract\.owns: "ghost" is not a role/,
    );
    refuseV2((d) => (d.contract = { owns: { lead: "src/**" } }), /owns\.lead: must be an array/);
    refuseV2(
      (d) => (d.contract = { owns: { lead: Array(17).fill("a") } }),
      /owns\.lead: has more than 16/,
    );
    refuseV2((d) => (d.contract = { owns: { lead: ["x".repeat(201)] } }), /must be at most 200/);
  });

  it("checks glob dialect and overlaps", () => {
    refuseV2(
      (d) => (d.contract = { owns: { lead: ["../x"] } }),
      /owns\.lead\[0\]: invalid glob "\.\.\/x" \(must not contain a \.\. segment\)/,
    );
    refuseV2((d) => (d.contract = { owns: { lead: ["src/{a,b}"] } }), /invalid glob/);
    refuseV2(
      (d) => (d.contract = { owns: { reviewerA: ["src/**"], reviewerB: ["src/web/"] } }),
      /contract\.owns: reviewerA "src\/\*\*" overlaps reviewerB "src\/web\/"/,
    );
    const ok = v2();
    ok.contract = { owns: { reviewerA: ["src/a/**"], reviewerB: ["src/b/"], lead: ["docs/*.md"] } };
    expect(validateWorkflow(ok).ok).toBe(true);
    // 同一角色自己的 glob 互相重叠不算冲突。
    const same = v2();
    same.contract = { owns: { reviewerA: ["src/**", "src/a/"] } };
    expect(validateWorkflow(same).ok).toBe(true);
  });

  it("warns when two roles share a worktree", () => {
    const d = v2();
    d.roles[0].worktree = "w";
    d.roles[1].worktree = "w";
    const r = validateWorkflow(d);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      {
        path: "roles",
        message: 'roles share worktree "w"; standalone runs give each role its own worktree',
        severity: "warning",
      },
    ]);
  });
});
