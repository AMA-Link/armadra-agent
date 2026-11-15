import { describe, expect, it } from "vitest";

import {
  isDocsOnly,
  parsePushLines,
  parseSkip,
  planChecks,
  refsToCheck,
} from "../../scripts/hooks/pre-push.mjs";

const SHA = "a".repeat(40);
const ZERO = "0".repeat(40);

describe("pre-push：推送的 ref", () => {
  it("删除分支与 tag 不查", () => {
    const updates = parsePushLines(
      [
        `refs/heads/x ${SHA} refs/heads/x ${ZERO}`,
        `(delete) ${ZERO} refs/heads/gone ${SHA}`,
        `refs/tags/v1 ${SHA} refs/tags/v1 ${ZERO}`,
      ].join("\n"),
    );
    expect(refsToCheck(updates).map((update) => update.remoteRef)).toEqual(["refs/heads/x"]);
  });

  it("ARMADRA_SKIP_PREPUSH：1 跳过全部，逗号列表跳过指定步骤", () => {
    expect(parseSkip("1").all).toBe(true);
    expect([...parseSkip("test, e2e").steps]).toEqual(["test", "e2e"]);
  });
});

describe("pre-push：挑检查", () => {
  it("只改文档与 CI 的判定一致", () => {
    expect(isDocsOnly(["docs/guides/a.md", "README.md"])).toBe(true);
    expect(isDocsOnly(["THIRD_PARTY_NOTICES.md"])).toBe(false);
    const plan = planChecks(["docs/guides/a.md"], { base: SHA });
    expect(plan.statics.map((step) => step.id)).toEqual(["format", "check:docs"]);
    expect(plan.after).toEqual([]);
  });

  it("改源码：静态检查、构建与冒烟、按模块图挑的单测与 bundle 端到端", () => {
    const plan = planChecks(["src/cli/main.ts"], { base: SHA });
    expect(plan.statics.map((step) => step.id)).toContain("check:portability");
    expect(plan.build.map((step) => step.id)).toEqual(["build", "bundle"]);
    expect(plan.after.map((step) => step.id)).toEqual(["test", "e2e"]);
    expect(plan.after[0]?.args).toEqual([
      "exec",
      "vitest",
      "run",
      "--changed",
      SHA,
      "--passWithNoTests",
    ]);
  });

  it("只改测试：不构建；改测试辅助：单测全量", () => {
    expect(planChecks(["src/cli/main.test.ts"], { base: SHA }).build).toEqual([]);
    const plan = planChecks(["test/helpers/fake.ts"], { base: SHA });
    expect(plan.after[0]?.args).toEqual(["exec", "vitest", "run"]);
  });

  it("workflow 与 models.dev 相关文件触发对应检查", () => {
    const plan = planChecks([".github/workflows/ci.yml", "scripts/update-models-dev.mjs"], {
      base: SHA,
    });
    expect(plan.actionlint).toBe(true);
    expect(plan.modelsDev).toBe(true);
  });
});
