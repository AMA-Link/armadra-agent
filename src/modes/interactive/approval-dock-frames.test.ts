/**
 * 后台任务审批停靠的交互帧（docs/history/agents-concurrency-plan.md §2.7，W7-C）：主会话忙时后台任务的审批不弹，
 * 停靠在 Agent 栏（「等待审批」+ 运行提示行「↓ 处理审批」），主会话空闲且空输入时自动弹出；有草稿时继续停靠，
 * 清空后弹出；栏里 Enter 打开该任务的视图即弹出。主会话自己的审批（task 调用）照旧立即弹出。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedCacheReporting } from "../../ai/cache/reporting.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
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

const CTRL_B = "\x02";
const CTRL_C = "\x03";
const DOWN = "\x1b[B";

/**
 * 父会话前台调 task（主会话自己的审批，立即弹出）；转后台后父会话的回复停在闸门 `parent` 上（期间主会话忙，
 * 由用例放行，不靠墙钟）；子会话停在闸门 `child` 上，转后台后放行，随即要写文件（后台任务的审批）；
 * 写完回报，最后是通知回合。
 */
function script(reply: string): FakeResponse[] {
  return [
    {
      steps: [
        {
          toolCall: {
            name: "task",
            arguments: {
              prompt: "write a note",
              description: "note",
              agent: "general",
              background: false,
            },
          },
        },
      ],
    },
    {
      gate: "child",
      steps: [{ toolCall: { name: "write", arguments: { path: "note.txt", content: "hi\n" } } }],
    },
    { gate: "parent", text: reply },
    { text: "写好了" },
    { text: "收到通知" },
  ];
}

const ARGV = ["--tools", "read,task,write", "--permission-mode", "default"];
// 帧黄金里的「已转后台」提示由限时计时器清除：golden 用例走手动时钟（manualHints），不随 runner 卡顿变化

/** 发消息、批准主会话的 task 调用、Ctrl+B 转后台，等子会话的审批停靠。 */
async function docked(s: Started, label: RegExp): Promise<void> {
  s.type("write it\r");
  await waitFor(s, (x) => x.includes("3. 拒绝") || x.includes("3. Deny"), "task approval");
  s.type("y");
  await waitFor(s, (x) => /Ctrl\+B/.test(x), "task running");
  s.type(CTRL_B);
  s.release("child");
  await waitFor(s, (x) => label.test(x), "docked");
}

describe("后台任务审批停靠", () => {
  it("zh 80×24：忙时停靠在栏里，主会话空闲且空输入时自动弹出", async () => {
    const s = await start(script("父会话回复"), { argv: ARGV, manualHints: true });
    await docked(s, /等待审批/);
    expect(s.handle.tui.hasOverlay).toBe(false);
    const screen = s.terminal.viewport().join("\n");
    expect(screen).toMatch(/⏺ t1 general · 等待审批/);
    expect(screen).toMatch(/↓ 处理审批/);
    golden("approval-docked-80x24", shot(s, "主会话忙：后台任务的审批停靠"));
    // 放行父会话的回复；回复完、空闲后自动弹出（弹框会盖住回复）。[#236] 先等主会话真正空闲（事件），再等弹框：
    // 弹出由 agent_settled 排下的 poke 触发，waitScreen 的墙钟截止不再跨过父会话回复——跨过时机器一卡顿，
    // 醒来后先到期的是截止检查而不是 poke
    s.release("parent");
    await s.handle.session().waitForIdle();
    await waitFor(s, () => s.handle.tui.hasOverlay, "auto popup");
    expect(s.handle.session().state.isStreaming).toBe(false);
    await waitFor(s, (x) => x.includes("[task:general]"), "dialog");
    golden("approval-docked-popup-80x24", shot(s, "主会话空闲：自动弹出"));
    s.type("y");
    await waitFor(s, (x) => x.includes("收到通知"), "notification turn", 10_000);
    await s.handle.session().waitForIdle();
    s.handle.exit(0);
    await s.done;
  });

  it("有草稿时继续停靠，清空后弹出", async () => {
    const s = await start(script("父会话回复"), { argv: ARGV });
    await docked(s, /等待审批/);
    s.type("草稿");
    s.release("parent");
    await waitFor(s, (x) => x.includes("父会话回复"), "parent reply");
    await s.handle.session().waitForIdle();
    // 停靠态没有墙钟可等：让事件循环转几圈，弹框（若会触发）由 agent_settled 排下的 poke 在这几圈里到达
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    s.frame();
    expect(s.handle.tui.hasOverlay).toBe(false);
    expect(s.terminal.viewport().join("\n")).toMatch(/t1 general · 等待审批/);
    s.type(CTRL_C);
    await waitFor(s, () => s.handle.tui.hasOverlay, "popup after clearing");
    s.type("n");
    await waitFor(s, (x) => x.includes("已拒绝 [task:general] write"), "denied");
    await s.handle.session().waitForIdle();
    s.handle.exit(0);
    await s.done;
  });

  it("栏里 Enter 打开该任务的视图：立即弹出（盖在视图上）", async () => {
    const s = await start(script("父会话回复"), { argv: ARGV });
    await docked(s, /等待审批/);
    s.type(DOWN);
    await waitFor(s, (x) => x.includes("Enter 打开"), "bar focused");
    s.type("\r");
    await waitFor(s, (x) => x.includes("[task:general]"), "popup in view");
    expect(s.handle.session().state.isStreaming).toBe(true);
    s.type("y");
    s.handle.exit(0);
    await s.done;
  });

  it("en 80×24：停靠帧", async () => {
    setLocale("en");
    const s = await start(script("parent reply"), { argv: ARGV, manualHints: true });
    await docked(s, /needs approval/);
    expect(s.terminal.viewport().join("\n")).toMatch(/↓ handle approval/);
    golden("en/approval-docked-80x24", shot(s, "main busy: background approval docked"));
    s.handle.exit(0);
    await s.done;
  });
});
