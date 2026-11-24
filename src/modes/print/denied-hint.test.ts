import { describe, expect, it } from "vitest";
import { CLASSIFIER_UNAVAILABLE_MESSAGE, UNATTENDED_MESSAGE } from "../../permissions/pipeline.js";
import { describeDenied } from "./print-mode.js";

const denied = (reason: string) => ({ toolCallId: "c1", toolName: "bash", reason });

describe("[#313] -p 被拒摘要", () => {
  it("分类器不可用：说明真实原因，不再建议切到 auto", () => {
    const text = describeDenied([denied(CLASSIFIER_UNAVAILABLE_MESSAGE)]);
    expect(text).toContain("permission.autoModel");
    expect(text).not.toContain("--permission-mode");
  });

  it("普通无人审批：提示不变", () => {
    expect(describeDenied([denied(UNATTENDED_MESSAGE)])).toContain("--permission-mode");
  });
});
