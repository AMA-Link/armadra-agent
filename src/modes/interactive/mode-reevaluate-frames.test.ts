/**
 * [#271] 审批对话框打开时切换权限模式：Shift+Tab 仍能循环；切换后按新模式重判在等的审批——放行的收起对话框并在
 * 消息区留一行，拒绝的同样收起并给模型写明切换；危险命令切到 Bypass 也照旧要人确认；Tab 归对话框。
 * 帧黄金 `test/fixtures/tui/mode-reevaluate-*.txt`。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedCacheReporting } from "../../ai/cache/reporting.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import { currentSession } from "../../cli/compose-session.js";
import { setLocale } from "../../i18n/index.js";
import {
  cleanupStarted,
  golden,
  start,
  timedShot as shot,
  waitScreen as waitFor,
  type Started,
} from "./test-support.js";

afterEach(cleanupStarted);
afterEach(() => setLocale("zh"));
beforeEach(() => sharedCacheReporting.clear());

const SHIFT_TAB = "\x1b[Z";
const DIALOG = (x: string): boolean => x.includes("3. 拒绝") || x.includes("3. Deny");
const mode = (s: Started): string => currentSession(s.rt).state.permissionMode;
const screen = (s: Started): string => s.terminal.viewport().join("\n");

function script(call: { name: string; arguments: Record<string, unknown> }): FakeResponse[] {
  return [{ steps: [{ toolCall: call }] }, { text: "结束" }];
}

/** 发消息、等审批对话框弹出。 */
async function pending(s: Started): Promise<void> {
  s.type("做吧\r");
  await waitFor(s, DIALOG, "approval dialog");
  expect(s.handle.tui.hasOverlay).toBe(true);
}

describe("对话框打开时切模式：重判待审批", () => {
  it("Manual → Accept edits：在等的写入自动放行，对话框收起，消息区一行提示（帧黄金）", async () => {
    const s = await start(
      script({ name: "write", arguments: { path: "note.txt", content: "hi\n" } }),
      {
        argv: ["--tools", "read,write,bash", "--permission-mode", "default"],
      },
    );
    await pending(s);
    // Tab 归对话框：不切模式
    s.type("\t");
    expect(mode(s)).toBe("default");
    expect(s.handle.tui.hasOverlay).toBe(true);
    const ended = s.until((e) => e.type === "tool_execution_end");
    // 帧要在这一轮真正收尾之后截：只等屏上出现最终回复时，慢机器上转圈行与用量还没刷新（CI 偶发）
    const settled = s.until((e) => e.type === "agent_settled");
    s.type(SHIFT_TAB);
    expect(mode(s)).toBe("auto-edit");
    expect(s.handle.tui.hasOverlay).toBe(false);
    await ended;
    await settled;
    await waitFor(s, (x) => x.includes("结束"), "final reply");
    const shown = screen(s);
    expect(shown).toContain("已按 Accept edits 自动允许 1 个待审批");
    expect(shown).not.toContain("审批已取消");
    golden("mode-reevaluate-allowed-80x24", shot(s, "shift-tab"));
    s.handle.exit(0);
    await s.done;
  });

  it("Accept edits → Plan：在等的命令自动拒绝，给模型的结果写明切换", async () => {
    const s = await start(script({ name: "bash", arguments: { command: "make build" } }), {
      argv: ["--tools", "read,write,bash", "--permission-mode", "auto-edit"],
    });
    await pending(s);
    let result = "";
    const ended = s.until((e) => {
      if (e.type !== "tool_execution_end") return false;
      result = JSON.stringify(e.result);
      return true;
    });
    s.type(SHIFT_TAB);
    expect(mode(s)).toBe("plan");
    expect(s.handle.tui.hasOverlay).toBe(false);
    await ended;
    expect(result).toContain('switched to \\"plan\\"');
    await waitFor(s, (x) => x.includes("已按 Plan 自动拒绝 1 个待审批"), "denied notice");
    expect(screen(s)).not.toContain("已拒绝 bash");
    s.handle.exit(0);
    await s.done;
  });

  it("Auto → Bypass：先弹确认框叠在审批框上（帧黄金），确认后放行；确认期间 Shift+Tab 不重复触发", async () => {
    const s = await start(script({ name: "bash", arguments: { command: "rm -f old.txt" } }), {
      argv: ["--tools", "read,write,bash", "--permission-mode", "auto"],
    });
    await pending(s);
    s.type(SHIFT_TAB);
    expect(mode(s)).toBe("auto");
    expect(screen(s)).toContain("进入 Bypass permissions？");
    expect(screen(s)).toContain("需要确认");
    golden("mode-reevaluate-confirm-80x24", shot(s, "confirm over approval"));
    s.type(SHIFT_TAB);
    expect(mode(s)).toBe("auto");
    const ended = s.until((e) => e.type === "tool_execution_end");
    s.type("y");
    await new Promise((r) => setTimeout(r, 10));
    s.frame();
    expect(mode(s)).toBe("full-auto");
    expect(s.handle.tui.hasOverlay).toBe(false);
    await ended;
    await waitFor(s, (x) => x.includes("已按 Bypass permissions 自动允许 1 个待审批"), "notice");
    s.handle.exit(0);
    await s.done;
  });

  it("危险命令：一路切到 Bypass 仍停在对话框里等人；en 文案", async () => {
    setLocale("en");
    const s = await start(script({ name: "bash", arguments: { command: "git push --force" } }), {
      argv: ["--tools", "read,write,bash", "--permission-mode", "default"],
    });
    await pending(s);
    for (const expected of ["auto-edit", "plan", "auto"]) {
      s.type(SHIFT_TAB);
      expect(mode(s)).toBe(expected);
      expect(s.handle.tui.hasOverlay).toBe(true);
    }
    s.type(SHIFT_TAB);
    s.type("y");
    await new Promise((r) => setTimeout(r, 10));
    s.frame();
    expect(mode(s)).toBe("full-auto");
    expect(screen(s)).toContain("Dangerous command");
    expect(screen(s)).not.toContain("Auto-allowed");
    const ended = s.until((e) => e.type === "tool_execution_end");
    s.type("n");
    await ended;
    await waitFor(s, (x) => x.includes("Denied bash"), "denied");
    s.handle.exit(0);
    await s.done;
  });
});
