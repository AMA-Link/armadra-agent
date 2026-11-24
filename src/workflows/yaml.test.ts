import { describe, expect, it } from "vitest";
import { parseYaml, stringifyYaml, type YamlValue } from "./yaml.js";

function ok(text: string): YamlValue {
  const r = parseYaml(text);
  expect(r.errors).toEqual([]);
  return r.value;
}

function fails(text: string): { line: number; message: string } {
  const r = parseYaml(text);
  expect(r.errors).toHaveLength(1);
  return r.errors[0]!;
}

function roundTrip(v: YamlValue): void {
  const text = stringifyYaml(v);
  const r = parseYaml(text);
  expect(r.errors, text).toEqual([]);
  expect(r.value, text).toEqual(v);
  expect(stringifyYaml(r.value)).toBe(text);
}

const SAMPLE = `version: 2
title: Split a feature into API and UI
params:
  - name: feature
    type: text
    label: What to build
roles:
  - id: api
    agentId: ama
    tier: strong
    worktree: api
  - id: ui
    agentId: ama
    tier: standard
    worktree: ui
  - id: lead
    agentId: ama
    tier: strong
contract:
  text: |
    Interface: POST /api/items -> { id: string }
    Constraint: no new runtime dependencies.
  owns:
    api: ["src/server/"]
    ui: ["src/web/**"]
steps:
  - id: build-api
    kind: prompt
    role: api
    prompt: "Implement the server side of {{feature}}."
  - id: build-ui
    kind: prompt
    role: ui
    prompt: "Implement the UI of {{feature}} against the contract."
  - id: review
    kind: gate
    label: Review both parts before merging
    after: [build-api, build-ui]
  - id: integrate
    kind: collect
    role: lead
    from: [build-api, build-ui]
    after: [review, build-api, build-ui]
    prompt: Merge both branches and summarize what changed.
    verify:
      commands: ["pnpm test"]
      checklist: ["The API route exists", "The UI calls it"]
    maxRetries: 1
`;

describe("parseYaml scalars", () => {
  it("resolves numbers, booleans and null", () => {
    expect(
      ok("a: 1\nb: -2\nc: 1.5\nd: .5\ne: 1e3\nf: true\ng: false\nh: null\ni: ~\nj:\n"),
    ).toEqual({
      a: 1,
      b: -2,
      c: 1.5,
      d: 0.5,
      e: 1000,
      f: true,
      g: false,
      h: null,
      i: null,
      j: null,
    });
  });

  it("keeps non-numeric lookalikes as strings", () => {
    expect(ok("a: 1.2.3\nb: 0x1f\nc: v2\nd: 12abc\ne: truthy")).toEqual({
      a: "1.2.3",
      b: "0x1f",
      c: "v2",
      d: "12abc",
      e: "truthy",
    });
  });

  it("handles quotes and escapes", () => {
    expect(ok(`a: "x\\ny\\t\\"q\\" \\u0041 \\x41"\nb: 'it''s'\nc: "1"\nd: 'null'`)).toEqual({
      a: 'x\ny\t"q" A A',
      b: "it's",
      c: "1",
      d: "null",
    });
  });

  it("strips comments but not inside quotes or urls", () => {
    expect(ok('a: x # note\nb: "x # y" # note\nc: http://h/p#frag\n# whole line\nd: 1')).toEqual({
      a: "x",
      b: "x # y",
      c: "http://h/p#frag",
      d: 1,
    });
  });

  it("parses a root scalar and empty input", () => {
    expect(ok("hello")).toBe("hello");
    expect(ok("")).toBeNull();
    expect(ok("# only a comment\n\n")).toBeNull();
  });
});

describe("parseYaml collections", () => {
  it("parses nested mappings and sequences", () => {
    expect(
      ok("a:\n  b:\n    c: 1\n  d: [1, 2]\ne:\n  - x\n  - y: 1\n    z: 2\n  - - n\n    - m\n"),
    ).toEqual({
      a: { b: { c: 1 }, d: [1, 2] },
      e: ["x", { y: 1, z: 2 }, ["n", "m"]],
    });
  });

  it("accepts a sequence at the same indent as its key", () => {
    expect(ok("a:\n- 1\n- 2\nb: 3")).toEqual({ a: [1, 2], b: 3 });
  });

  it("parses flow collections", () => {
    expect(
      ok(`a: []\nb: {}\nc: [a, "b, c", 'd', 1, true, null]\nd: {x: 1, "y z": [1, {k: v}], w: }`),
    ).toEqual({
      a: [],
      b: {},
      c: ["a", "b, c", "d", 1, true, null],
      d: { x: 1, "y z": [1, { k: "v" }], w: null },
    });
    expect(ok("a: [1, 2,] # trailing")).toEqual({ a: [1, 2] });
  });

  it("handles empty items and blank lines between entries", () => {
    expect(ok("a:\n  -\n  - 1\n\n  # c\n  -\nb: 2")).toEqual({ a: [null, 1, null], b: 2 });
  });

  it("supports quoted keys", () => {
    expect(ok(`"a b": 1\n'c: d': 2`)).toEqual({ "a b": 1, "c: d": 2 });
  });

  it("does not pollute prototypes", () => {
    const v = ok("__proto__: 1\nb: 2") as Record<string, YamlValue>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.keys(v)).toEqual(["__proto__", "b"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("accepts CRLF line endings", () => {
    expect(ok("a: 1\r\nb:\r\n  - x\r\n")).toEqual({ a: 1, b: ["x"] });
  });
});

describe("parseYaml block scalars", () => {
  it("literal clip and strip", () => {
    expect(ok("a: |\n  one\n   two\n\n  three\n\n\nb: |-\n  x\n  y\nc: 1")).toEqual({
      a: "one\n two\n\nthree\n",
      b: "x\ny",
      c: 1,
    });
  });

  it("folded", () => {
    expect(ok("a: >\n  one\n  two\n\n  three\nb: >-\n  x\n  y")).toEqual({
      a: "one two\nthree\n",
      b: "x y",
    });
  });

  it("works inside sequences", () => {
    expect(ok("- |\n  a\n  b\n- x")).toEqual(["a\nb\n", "x"]);
    expect(ok("- k: |-\n    a\n    b\n  j: 1")).toEqual([{ k: "a\nb", j: 1 }]);
  });

  it("keeps content that looks like yaml", () => {
    expect(ok("a: |\n  # not a comment\n  - not: a list\n  --- \nb: 1")).toEqual({
      a: "# not a comment\n- not: a list\n--- \n",
      b: 1,
    });
  });

  it("empty block scalar is an empty string", () => {
    expect(ok("a: |\nb: 1")).toEqual({ a: "", b: 1 });
  });
});

describe("parseYaml errors", () => {
  it("rejects anchors, aliases and tags", () => {
    expect(fails("a: 1\nb: &x 2")).toMatchObject({ line: 2 });
    expect(fails("a: *x")).toMatchObject({ line: 1 });
    expect(fails("a: 1\nb: 2\nc: !!str 3")).toMatchObject({ line: 3 });
    expect(fails("a: [&x 1]")).toMatchObject({ line: 1 });
  });

  it("rejects multiple documents", () => {
    expect(fails("a: 1\n---\nb: 2")).toMatchObject({ line: 2 });
    expect(fails("a: 1\n...\n")).toMatchObject({ line: 2 });
  });

  it("rejects tab indentation", () => {
    expect(fails("a:\n\tb: 1")).toMatchObject({ line: 2 });
    expect(fails("a: 1\nb:\n  - x\n \t- y")).toMatchObject({ line: 4 });
  });

  it("rejects bad indentation and stray content", () => {
    expect(fails("a: 1\n  b: 2")).toMatchObject({ line: 2, message: "bad indentation" });
    expect(fails("a:\n  b: 1\n c: 2")).toMatchObject({ line: 3 });
    expect(fails("- a\nb: 1")).toMatchObject({ line: 2 });
    expect(fails("a: 1\n- b")).toMatchObject({ line: 2 });
    expect(fails("a: 1\njust text")).toMatchObject({ line: 2 });
  });

  it("rejects duplicate keys", () => {
    expect(fails("a: 1\nb: 2\na: 3")).toMatchObject({ line: 3 });
    expect(fails("a: {x: 1, x: 2}")).toMatchObject({ line: 1 });
  });

  it("rejects unterminated and malformed values", () => {
    expect(fails('a: 1\nb: "open')).toMatchObject({ line: 2 });
    expect(fails("a: 'open")).toMatchObject({ line: 1 });
    expect(fails("a: [1, 2")).toMatchObject({ line: 1 });
    expect(fails("a: {x: 1")).toMatchObject({ line: 1 });
    expect(fails('a: "x" y')).toMatchObject({ line: 1 });
    expect(fails("a: [1] y")).toMatchObject({ line: 1 });
    expect(fails('a: "\\q"')).toMatchObject({ line: 1 });
    expect(fails("a: [1,, 2]")).toMatchObject({ line: 1 });
  });

  it("rejects ambiguous plain scalars and unsupported block headers", () => {
    expect(fails("a: b: c")).toMatchObject({ line: 1 });
    expect(fails("a: |+\n  x")).toMatchObject({ line: 1 });
    expect(fails("a: |2\n  x")).toMatchObject({ line: 1 });
  });

  it("reports only the failing line number and never throws", () => {
    const r = parseYaml("a: 1\nb: 2\nc: &x 3");
    expect(r.value).toBeNull();
    expect(r.errors).toEqual([{ line: 3, message: "anchors and aliases are not supported" }]);
  });
});

describe("stringifyYaml", () => {
  it("is deterministic with two-space indentation", () => {
    expect(stringifyYaml({ a: 1, b: ["x", { c: true, d: null }], e: {}, f: [] })).toBe(
      "a: 1\nb:\n  - x\n  - c: true\n    d: null\ne: {}\nf: []\n",
    );
    expect(stringifyYaml([[1, 2], []])).toBe("- - 1\n  - 2\n- []\n");
    expect(stringifyYaml("x")).toBe("x\n");
  });

  it("quotes strings that would parse as something else", () => {
    const quoted = [
      "",
      " lead",
      "trail ",
      "1",
      "1.5",
      "true",
      "False",
      "null",
      "~",
      "a: b",
      "a:",
      "x #y",
      "#x",
      "- x",
      "-",
      "? x",
      "[a]",
      "{a}",
      "*a",
      "&a",
      "!t",
      "|",
      ">",
      "'q'",
      '"q"',
      "@x",
      "---",
      "tab\there",
    ];
    for (const s of quoted) {
      const out = stringifyYaml({ k: s });
      expect(out.startsWith('k: "'), s).toBe(true);
      roundTrip({ k: s });
    }
    expect(stringifyYaml({ k: "a-b/c.d", "x y": "plain text, ok" })).toBe(
      'k: a-b/c.d\n"x y": plain text, ok\n',
    );
  });

  it("uses block scalars for multi-line strings", () => {
    expect(stringifyYaml({ a: "x\ny\n", b: "x\ny", c: "x\n\ny" })).toBe(
      "a: |\n  x\n  y\nb: |-\n  x\n  y\nc: |-\n  x\n\n  y\n",
    );
    expect(stringifyYaml(["x\ny\n"])).toBe("- |\n  x\n  y\n");
  });

  it("falls back to double quotes for awkward multi-line strings", () => {
    for (const s of ["\nx", " x\ny", "x\n\n", "x\n  \ny", "a\r\nb", "x\n\t\ny", "\n"]) {
      expect(stringifyYaml({ a: s }).startsWith('a: "'), JSON.stringify(s)).toBe(true);
      roundTrip({ a: s });
    }
  });

  it("quotes keys when needed", () => {
    expect(stringifyYaml({ "a b": 1, "": 2, ok_key: 3, "x:y": 4 })).toBe(
      '"a b": 1\n"": 2\nok_key: 3\n"x:y": 4\n',
    );
    roundTrip({ "a b": 1, "": 2, "x:y": 4, "#c": 5, "1": 6 });
  });

  it("rejects non-finite numbers", () => {
    expect(() => stringifyYaml(Number.NaN)).toThrow(RangeError);
    expect(() => stringifyYaml({ a: Infinity })).toThrow(RangeError);
  });
});

describe("round trip", () => {
  it("parse(stringify(x)) equals x", () => {
    const values: YamlValue[] = [
      null,
      true,
      0,
      -1.5,
      1e21,
      "plain",
      [],
      {},
      [[], {}, [[]], [{}]],
      { a: { b: { c: [1, [2, [3]], { d: "x\ny\n" }] } } },
      [{ a: 1, b: [{ c: "multi\nline" }] }, "last"],
      { unicode: "caf\u00e9 \u2603 \ud83d\ude00", esc: 'q"\\ \u0001', quote: "it's" },
      { a: "a\nb\n", b: ["x\ny", "z"] },
    ];
    for (const v of values) roundTrip(v);
  });

  it("round trips the design sample, text and value", () => {
    const value = ok(SAMPLE);
    expect(value).toMatchObject({
      version: 2,
      params: [{ name: "feature", type: "text", label: "What to build" }],
      contract: {
        text: "Interface: POST /api/items -> { id: string }\nConstraint: no new runtime dependencies.\n",
        owns: { api: ["src/server/"], ui: ["src/web/**"] },
      },
    });
    const steps = (value as { steps: Record<string, YamlValue>[] }).steps;
    expect(steps).toHaveLength(4);
    expect(steps[3]).toMatchObject({
      kind: "collect",
      from: ["build-api", "build-ui"],
      verify: { commands: ["pnpm test"], checklist: ["The API route exists", "The UI calls it"] },
      maxRetries: 1,
    });
    roundTrip(value);
  });
});

describe("performance", () => {
  it("parses a 1000-line file in under 50 ms", () => {
    const parts: string[] = ["version: 2", "steps:"];
    for (let i = 0; parts.length < 1000; i++) {
      parts.push(
        `  - id: s${i}`,
        "    kind: prompt",
        `    prompt: "do thing ${i}"`,
        `    after: [s${i - 1}]`,
      );
    }
    const text = parts.join("\n");
    const t0 = performance.now();
    const r = parseYaml(text);
    const dt = performance.now() - t0;
    expect(r.errors).toEqual([]);
    expect(dt).toBeLessThan(50);
  });
});

describe("robustness", () => {
  it("strips trailing comments in linear time", () => {
    const t0 = performance.now();
    const r = parseYaml(`a: x${" ".repeat(60000)}y`);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({ a: `x${" ".repeat(60000)}y` });
    expect(ok("a: x   # c\nb: x#y\nc: x\t#c")).toEqual({ a: "x", b: "x#y", c: "x" });
  });

  it("reports deep nesting as an error with a line number", () => {
    const flow = parseYaml(`a: ${"[".repeat(20000)}`);
    expect(flow.errors).toEqual([{ line: 1, message: "nesting too deep" }]);
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) lines.push(`${" ".repeat(i)}k:`);
    expect(parseYaml(lines.join("\n")).errors[0]).toMatchObject({ message: "nesting too deep" });
    const seq = parseYaml("- ".repeat(5000));
    expect(seq.errors).toEqual([{ line: 1, message: "nesting too deep" }]);
    const ok60 = `${"[".repeat(60)}${"]".repeat(60)}`;
    expect(parseYaml(ok60).errors).toEqual([]);
  });

  it("stringify rejects undefined and circular values with a clear message", () => {
    expect(() => stringifyYaml({ a: undefined } as unknown as YamlValue)).toThrow("undefined");
    const loop: { [key: string]: YamlValue } = {};
    loop.self = loop;
    expect(() => stringifyYaml(loop)).toThrow("circular");
    const shared: YamlValue = [1];
    expect(stringifyYaml({ a: shared, b: shared })).toBe("a:\n  - 1\nb:\n  - 1\n");
  });
});
