import { describe, expect, it } from "vitest";

import {
  buildChildEnv,
  buildCiPlan,
  type CiStep,
  parseCliArgs,
  runCiPlan,
} from "../../scripts/ci-run.mjs";

describe("ci-run：参数解析", () => {
  it("缺省关闭 e2e 与静态去重；识别 --with-e2e 与 --skip-repo-statics", () => {
    expect(parseCliArgs([])).toEqual({ withE2e: false, skipRepoStatics: false });
    expect(parseCliArgs(["--with-e2e"])).toEqual({ withE2e: true, skipRepoStatics: false });
    expect(parseCliArgs(["--with-e2e", "--skip-repo-statics"])).toEqual({
      withE2e: true,
      skipRepoStatics: true,
    });
  });

  it("未知参数直接报错", () => {
    expect(() => parseCliArgs(["--unknown"])).toThrow(/未知参数/);
  });
});

describe("ci-run：三阶段计划", () => {
  it("缺省计划：阶段 1 并行 9 项，阶段 2 冒烟，阶段 3 只跑单测", () => {
    const plan = buildCiPlan();
    expect(plan.phase1.map((step) => step.id)).toEqual([
      "typecheck",
      "fmt:check",
      "check:deps",
      "check:i18n",
      "check:docs",
      "check:portability",
      "release:check",
      "build:lib",
      "build:bundle",
    ]);
    expect(plan.phase2.map((step) => step.id)).toEqual(["bundle:smoke"]);
    expect(plan.phase3).toEqual([
      {
        id: "test",
        command: "pnpm",
        args: ["exec", "vitest", "run"],
        stream: true,
      },
    ]);
  });

  it("--with-e2e：阶段 3 合并单测与 e2e，一次启动 vitest", () => {
    const plan = buildCiPlan({ withE2e: true });
    expect(plan.phase3).toEqual([
      {
        id: "test+e2e",
        command: "pnpm",
        args: ["exec", "vitest", "run"],
        env: { AMA_E2E: "1" },
        stream: true,
      },
    ]);
  });

  it("--skip-repo-statics：只跳过平台无关全仓静态检查，保留 typecheck、跨平台检查与构建测试", () => {
    const plan = buildCiPlan({ withE2e: true, skipRepoStatics: true });
    expect(plan.phase1.map((step) => step.id)).toEqual([
      "typecheck",
      "check:portability",
      "release:check",
      "build:lib",
      "build:bundle",
    ]);
    expect(plan.phase2.map((step) => step.id)).toEqual(["bundle:smoke"]);
    expect(plan.phase3.map((step) => step.id)).toEqual(["test+e2e"]);
  });

  it("子进程环境清掉非交互调用方继承的 TERM=dumb，保留正常 TERM", () => {
    expect(buildChildEnv({ TERM: "dumb", PATH: "/bin" }).TERM).toBeUndefined();
    expect(buildChildEnv({ TERM: "xterm-256color" }).TERM).toBe("xterm-256color");
    expect(buildChildEnv({ TERM: "dumb" }, { TERM: "dumb" }).TERM).toBe("dumb");
  });
});

describe("ci-run：阶段编排与失败日志", () => {
  it("阶段 1 并行完成后才进阶段 2 与阶段 3", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const plan = {
      phase1: [
        { id: "a", command: "node", args: [] },
        { id: "b", command: "node", args: [] },
      ],
      phase2: [{ id: "smoke", command: "node", args: [] }],
      phase3: [{ id: "test", command: "pnpm", args: [], stream: true }],
    };
    const result = await runCiPlan(plan, {
      writeLine: (line) => lines.push(line),
      runStep: async (step: CiStep) => {
        order.push(`start:${step.id}`);
        await Promise.resolve();
        order.push(`end:${step.id}`);
        return {
          id: step.id,
          ok: true,
          code: 0,
          durationMs: 12,
          output: "",
          streamed: Boolean(step.stream),
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(order.slice(0, 2)).toEqual(["start:a", "start:b"]);
    expect(order.indexOf("start:smoke")).toBeGreaterThan(order.indexOf("end:a"));
    expect(order.indexOf("start:smoke")).toBeGreaterThan(order.indexOf("end:b"));
    expect(order.indexOf("start:test")).toBeGreaterThan(order.indexOf("end:smoke"));
    expect(lines.at(-1)).toMatch(/^ci: 全部通过/);
  });

  it("阶段 1 失败时打印完整错误输出并终止后续阶段", async () => {
    const errors: string[] = [];
    const executed: string[] = [];
    const fullLog = Array.from({ length: 50 }, (_, i) => `err-line-${i + 1}`).join("\n");
    const plan = {
      phase1: [
        { id: "typecheck", command: "pnpm", args: [] },
        { id: "check:deps", command: "node", args: [] },
      ],
      phase2: [{ id: "bundle:smoke", command: "node", args: [] }],
      phase3: [{ id: "test", command: "pnpm", args: [], stream: true }],
    };
    const result = await runCiPlan(plan, {
      writeLine: () => undefined,
      writeError: (line) => errors.push(line),
      runStep: async (step: CiStep) => {
        executed.push(step.id);
        const fail = step.id === "typecheck";
        return {
          id: step.id,
          ok: !fail,
          code: fail ? 2 : 0,
          durationMs: 25,
          output: fail ? fullLog : "",
          streamed: false,
        };
      },
    });
    expect(result.ok).toBe(false);
    expect(executed).toEqual(["typecheck", "check:deps"]);
    expect(errors.join("\n")).toContain("err-line-1");
    expect(errors.join("\n")).toContain("err-line-50");
    expect(errors.at(-1)).toContain("typecheck");
  });
});
