/**
 * 回滚交互的集成测试（RW-C）：真实组装根（检查点后端写临时数据目录）+ fake 供应商 + MemoryTerminal。
 * 双击 Esc → 回滚列表 → 确认面板 → 恢复代码和对话；中断即撤回；`/rewind <n>` 带参数。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness } from "../../../test/helpers/compose-harness.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import { cleanupStarted, start, started, waitScreen, type Started } from "./test-support.js";

afterEach(cleanupStarted);

const EDIT_SCRIPT: FakeResponse[] = [
  { text: "好的" },
  { steps: [{ toolCall: { name: "read", arguments: { path: "a.txt" }, id: "r1" } }] },
  {
    steps: [
      {
        toolCall: {
          name: "edit",
          arguments: { path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
          id: "e1",
        },
      },
    ],
  },
  { text: "改好了" },
];

async function send(s: Started, text: string): Promise<void> {
  const settled = s.until((e) => e.type === "agent_settled");
  s.type(text);
  s.terminal.sendInput("\r");
  await settled;
  // agent_settled 先于运行状态收尾：等会话真正空闲，否则紧接着的 /rewind 会因「正在运行」被拒
  await s.handle.session().waitForIdle();
  s.frame();
}

/** 送一次按键并立即渲染，返回视口（不等待；同步完成的按键用它）。 */
function press(s: Started, data: string): string {
  s.terminal.sendInput(data);
  s.terminal.flushInput();
  s.frame();
  return s.terminal.viewport().join("\n");
}

/**
 * 送一次按键，逐帧等到视口满足 `ready`（回滚预览、写盘与摘要都是异步的）：等的是确定状态而不是固定毫秒，
 * 负载高时只是多等几帧，不会放宽断言。
 */
async function pressUntil(
  s: Started,
  data: string,
  ready: (screen: string) => boolean,
  label: string,
): Promise<string> {
  s.terminal.sendInput(data);
  s.terminal.flushInput();
  await waitScreen(s, ready, label);
  return s.terminal.viewport().join("\n");
}

const has =
  (...parts: string[]) =>
  (screen: string): boolean =>
    parts.every((part) => screen.includes(part));

function fileOf(name: string): string {
  return readFileSync(join(started.h!.home.cwd, name), "utf8");
}

describe("回滚交互（MemoryTerminal + fake）", () => {
  it("edit 一个文件 → 双击 Esc → 恢复代码和对话：文件与对话回到之前、输入框回填", async () => {
    const s = await start(EDIT_SCRIPT, {
      files: { "a.txt": "alpha\n" },
      argv: ["--permission-mode", "auto-edit"],
    });
    await send(s, "第一条");
    await send(s, "把 alpha 改成大写");
    expect(fileOf("a.txt")).toBe("ALPHA\n");
    expect(
      s.handle
        .session()
        .rewindPoints()
        .map((p) => p.hasCheckpoint),
    ).toEqual([true, true]);

    let screen = await pressUntil(s, "\x1b", has("再按 Esc 回滚"), "esc hint");
    expect(screen).toContain("再按 Esc 回滚");
    // 改动统计是异步预览（dryRun）：等到出现为止
    screen = await pressUntil(
      s,
      "\x1b",
      (x) => x.includes("回滚到哪条消息之前") && /把 alpha 改成大写.*1 文件 \+1 −1/.test(x),
      "rewind list with stats",
    );
    expect(screen).toMatch(/把 alpha 改成大写.*1 文件 \+1 −1/);

    screen = await pressUntil(s, "\r", has("回滚到这条消息之前", "3. 恢复代码"), "confirm panel");
    expect(screen).toContain("回滚到这条消息之前");
    expect(screen).toContain("1. 恢复代码和对话");
    expect(screen).toContain("将恢复 1 个文件 +1 −1 · 对话将分叉");
    expect(screen).toContain("3. 恢复代码");

    // 恢复是异步写盘；结果通知排在写盘、重画和回填之后，等通知出现即全部完成
    screen = await pressUntil(
      s,
      "1",
      has("已恢复 1 个文件", "对话已回到这条消息之前，原消息已放回输入框"),
      "restore result",
    );
    expect(fileOf("a.txt")).toBe("alpha\n");
    expect(s.handle.editor.getText()).toBe("把 alpha 改成大写");
    const users = s.handle.session().messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(screen).toContain("已恢复 1 个文件");
    expect(screen).toContain("对话已回到这条消息之前，原消息已放回输入框");
    expect(screen).not.toContain("改好了");
    s.handle.exit(0);
    await s.done;
  });

  it("/rewind → 列表 → 从这里摘要（行内说明）：分叉并回填，说明进摘要请求", async () => {
    const s = await start([...EDIT_SCRIPT, { text: "离开的分支改了 a.txt" }], {
      files: { "a.txt": "alpha\n" },
      argv: ["--permission-mode", "auto-edit"],
    });
    await send(s, "第一条");
    await send(s, "把 alpha 改成大写");
    s.type("/rewind");
    await pressUntil(s, "\r", has("回滚到哪条消息之前"), "rewind list");
    let screen = await pressUntil(s, "\r", has("4. 从这里摘要"), "confirm panel");
    expect(screen).toContain("4. 从这里摘要");
    for (const key of ["\x1b[B", "\x1b[B", "\x1b[B", ..."只记文件名"]) press(s, key);
    screen = await pressUntil(s, "\r", has("已从这里分叉，离开的部分写成了摘要"), "summary result");
    expect(screen).toContain("已从这里分叉，离开的部分写成了摘要");
    expect(s.handle.editor.getText()).toBe("把 alpha 改成大写");
    expect(fileOf("a.txt")).toBe("ALPHA\n");
    const summaryCall = started.h!.fake.calls.at(-1)!;
    expect(JSON.stringify(summaryCall.context.messages)).toContain("只记文件名");
    s.handle.exit(0);
    await s.done;
  });

  it("输入框有字：双击 Esc 清空并存进输入历史，↑ 取回", async () => {
    const s = await start([]);
    s.type("写到一半的草稿");
    let screen = press(s, "\x1b");
    expect(screen).toContain("再按 Esc 清空");
    expect(s.handle.editor.getText()).toBe("写到一半的草稿");
    screen = press(s, "\x1b");
    expect(s.handle.editor.getText()).toBe("");
    expect(screen).toContain("已清空输入 · ↑ 取回");
    press(s, "\x1b[A");
    expect(s.handle.editor.getText()).toBe("写到一半的草稿");
    s.handle.exit(0);
    await s.done;
  });

  it("没有回合时双击 Esc 提示一行；Esc 之间按别的键重新计", async () => {
    const s = await start([]);
    press(s, "\x1b");
    s.type("x");
    s.handle.editor.clear();
    let screen = press(s, "\x1b");
    expect(screen).toContain("再按 Esc 回滚");
    screen = await pressUntil(s, "\x1b", has("还没有可回滚的消息"), "empty notice");
    expect(screen).toContain("还没有可回滚的消息");
    s.handle.exit(0);
    await s.done;
  });

  it("中断即撤回：本回合还没有输出、输入框为空 → 撤回并回填原消息", async () => {
    const s = await start([{ delayMs: 5_000, text: "slow" }]);
    const checkpointed = s.until(
      (e) =>
        e.type === "entry_appended" &&
        e.entry.type === "custom" &&
        e.entry.customType === "ama.checkpoint",
    );
    s.type("帮我看看");
    s.terminal.sendInput("\r");
    await checkpointed;
    const settled = s.until((e) => e.type === "agent_settled");
    s.terminal.sendInput("\x1b");
    s.terminal.flushInput();
    await settled;
    // 撤回在运行结束后异步完成，通知排在回填之后：等通知出现
    await waitScreen(s, has("已撤回被中断的消息"), "undo notice");
    expect(s.handle.editor.getText()).toBe("帮我看看");
    expect(s.handle.session().messages.some((m) => m.role === "user")).toBe(false);
    s.handle.exit(0);
    await s.done;
  });

  it("ui.restoreOnCancel=false：中断后不撤回", async () => {
    const script: FakeResponse[] = [{ delayMs: 5_000, text: "slow" }];
    started.h = composeHarness(script, { stdinIsTTY: true, stdoutIsTTY: true });
    started.h.home.write("home/.config/ama/config.json", {
      version: 1,
      ui: { restoreOnCancel: false },
    });
    const s = await start(script, { keepHarness: true });
    const checkpointed = s.until(
      (e) =>
        e.type === "entry_appended" &&
        e.entry.type === "custom" &&
        e.entry.customType === "ama.checkpoint",
    );
    s.type("别撤回");
    s.terminal.sendInput("\r");
    await checkpointed;
    const settled = s.until((e) => e.type === "agent_settled");
    s.terminal.sendInput("\x1b");
    s.terminal.flushInput();
    await settled;
    // 不撤回没有可观察的事件：等会话空闲（撤回判断挂在同一个空闲上，先于这里的续体）再让出一个宏任务
    await s.handle.session().waitForIdle();
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.handle.editor.getText()).toBe("");
    expect(s.handle.session().messages.some((m) => m.role === "user")).toBe(true);
    s.handle.exit(0);
    await s.done;
  });

  it("/rewind <n> conversation：对话回到之前并回填，文件不动", async () => {
    const s = await start(EDIT_SCRIPT, {
      files: { "a.txt": "alpha\n" },
      argv: ["--permission-mode", "auto-edit"],
    });
    await send(s, "第一条");
    await send(s, "把 alpha 改成大写");
    s.type("/rewind 2 conversation");
    const screen = await pressUntil(s, "\r", has("对话已回到这条消息之前"), "conversation result");
    expect(fileOf("a.txt")).toBe("ALPHA\n");
    expect(s.handle.editor.getText()).toBe("把 alpha 改成大写");
    expect(screen).toContain("对话已回到这条消息之前");
    s.handle.exit(0);
    await s.done;
  });
});
