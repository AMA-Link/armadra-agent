import { describe, expect, it } from "vitest";

import { findProblems } from "../../scripts/check-portability.mjs";

describe("check:portability", () => {
  const lines = (text: string) => findProblems(text, "x.test.ts").map((problem) => problem.line);

  it("抓到 PATH 用 : 写死的字面量、模板、join 与 split", () => {
    const text = [
      'run({ PATH: "/usr/bin:/bin" });',
      "run({ PATH: `${bin}:${process.env.PATH}` });",
      'run({ PATH: [a, b].join(":") });',
      'expect(env.PATH?.split(":")).toContain(bin);',
    ].join("\n");
    expect(lines(text)).toEqual([1, 2, 3, 4]);
  });

  it("按 delimiter 拼、按 POSIX 目标调用、win32 门控与 portability-ok 都放行", () => {
    const text = [
      "run({ PATH: [a, b].join(delimiter) });",
      'findExecutable("bwrap", { PATH: "/a:/b" }, check, "linux");',
      'describe.skipIf(process.platform === "win32")("x", () => run({ PATH: "/a:/b" }));',
      "// portability-ok: 远端是 Linux",
      'run({ PATH: "/a:/b" });',
      'run({ PATH: "C:\\\\tools" });',
    ].join("\n");
    expect(lines(text)).toEqual([]);
  });
});
