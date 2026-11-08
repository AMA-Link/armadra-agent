/**
 * 异常中断后 resume 的恢复提醒（#268）：模拟崩溃的会话文件 → 重开 → 第一次提示前经 `ama.reminder` 注入一次
 * （带 `details.recovery`）；第二次提示、第二次 resume 不重复；Esc 中断与干净结束不注入；系统提示不变；
 * 两种界面语言文本相同；子会话（depth > 0）也拿到。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../session/manager.js";
import type { SessionEntry } from "../session/types.js";
import {
  UNCLEAN_ABORTED_TYPE,
  UNCLEAN_REMINDER_TYPE,
  UNCLEAN_TRACE_TYPE,
  type UncleanEnd,
} from "../session/unclean-end.js";
import { setLocale } from "../i18n/index.js";
import { TRACE_CUSTOM_TYPE } from "../trace/types.js";
import { REMINDER_CUSTOM_TYPE, createRemindersExtension } from "./reminders.js";
import { RECOVERY_DETAILS, recoveryReminderText } from "./recovery-reminder.js";
import { ABORTED_CUSTOM_TYPE } from "./session-run.js";
import type { SessionExtensionFactory } from "./session-extensions.js";
import { traceWriterFactory } from "./session-trace-writer.js";
import { createHarness, userTexts, type Harness, type HarnessOptions } from "./testing/harness.js";
import type { ScriptStep } from "./testing/scripted-api.js";
import { stubTool } from "./testing/stubs.js";
import type { SessionEvent } from "./types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ama-recovery-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  setLocale("zh");
});

const bash = stubTool({ name: "bash", properties: { command: { type: "string" } } });
const write = stubTool({
  name: "write",
  properties: { path: { type: "string" }, content: { type: "string" } },
  permission: "write",
});
const reminders: SessionExtensionFactory = ({ core }) => createRemindersExtension(core);

function harness(script: ScriptStep[], extra: Partial<HarnessOptions> & { file?: string } = {}) {
  const { file, ...rest } = extra;
  return createHarness({
    script,
    tools: [bash, write],
    extensions: [reminders],
    ...(file === undefined ? { dir } : { file }),
    ...rest,
  });
}

const recoveryEntries = (entries: readonly SessionEntry[]) =>
  entries.filter(
    (e) =>
      e.type === "custom_message" &&
      e.customType === REMINDER_CUSTOM_TYPE &&
      (e.details as { recovery?: boolean } | undefined)?.recovery === true,
  );

/** 模拟崩溃：在已关闭的文件末尾直接追加一条带工具调用、没有结果的 assistant。 */
function appendDangling(
  file: string,
  calls: { id: string; name: string; args: Record<string, unknown> }[],
) {
  const manager = SessionManager.open(file);
  manager.append({
    type: "message",
    message: {
      role: "assistant",
      content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args })),
      api: "fake",
      provider: "fake",
      model: "echo",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
  });
  manager.close();
}

async function cleanSession(): Promise<string> {
  const h = harness([
    { toolCalls: [{ name: "bash", args: { command: "ls -la" } }] },
    { text: "done" },
  ]);
  await h.session.prompt("start");
  await h.session.dispose();
  return h.manager.file() as string;
}

function until(h: Harness, match: (event: SessionEvent) => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (h.events.some(match)) return resolve();
    const off = h.session.subscribe((event) => {
      if (!match(event)) return;
      off();
      resolve();
    });
  });
}

describe("恢复提醒", () => {
  it("类型名字面量与 agent 侧常量一致", () => {
    expect(UNCLEAN_ABORTED_TYPE).toBe(ABORTED_CUSTOM_TYPE);
    expect(UNCLEAN_REMINDER_TYPE).toBe(REMINDER_CUSTOM_TYPE);
    expect(UNCLEAN_TRACE_TYPE).toBe(TRACE_CUSTOM_TYPE);
  });

  it("悬空调用 → resume 后第一次提示前注入一次（details.recovery），列出上一轮的工具与目标；之后不再注入", async () => {
    const file = await cleanSession();
    appendDangling(file, [
      { id: "x1", name: "bash", args: { command: "git push origin feat" } },
      { id: "x2", name: "write", args: { path: "notes.md", content: "never shown" } },
    ]);
    const h = harness([{ text: "checked" }, { text: "again" }], { file });
    const systemBefore = h
      .fileEntries()
      .filter((e) => e.type === "message" && e.message.role === "system").length;
    await h.session.prompt("continue");
    const found = recoveryEntries(h.fileEntries());
    expect(found).toHaveLength(1);
    const entry = found[0] as Extract<SessionEntry, { type: "custom_message" }>;
    expect(entry.display).toBe(false);
    expect(entry.details).toEqual(RECOVERY_DETAILS);
    const text = String(entry.content);
    expect(text).toMatch(/^<system-reminder>\n[\s\S]*\n<\/system-reminder>$/);
    expect(text).toContain("ended abruptly");
    expect(text).toContain("bash git (no result)");
    expect(text).toContain("write notes.md (no result)");
    expect(text).not.toContain("never shown");
    expect(text).not.toContain("ls -la"); // 上上轮的调用不在清单里
    // 进请求：作为 user 消息接在提示之后；系统提示没有新条目
    const request = h.scripted.calls[0]?.context;
    expect(userTexts(request!).at(-1)).toBe(text);
    expect(userTexts(request!).at(-2)).toBe("continue");
    expect(request!.messages[0]?.role).toBe("system");
    const systemAfter = h
      .fileEntries()
      .filter((e) => e.type === "message" && e.message.role === "system").length;
    expect(systemAfter).toBe(systemBefore);

    await h.session.prompt("more");
    expect(recoveryEntries(h.fileEntries())).toHaveLength(1);
    await h.session.dispose();

    // 模型已经正常回复：第二次 resume 是干净的
    const again = harness([{ text: "fine" }], { file });
    await again.session.prompt("later");
    expect(recoveryEntries(again.fileEntries())).toHaveLength(1);
    await again.session.dispose();
  });

  it("注入后模型还没回复就又被杀：第二次 resume 不重复（靠已落盘的 details.recovery）", async () => {
    const file = await cleanSession();
    appendDangling(file, [{ id: "x1", name: "bash", args: { command: "npm publish" } }]);
    // 第一次 resume：提示 + 提醒落盘，模型回复前进程结束（脚本挂起后直接关文件）
    const first = harness([{ kind: "hang" }], { file });
    const run = first.session.prompt("continue");
    await until(first, (e) => e.type === "message_start" && e.message.role === "assistant");
    expect(recoveryEntries(first.fileEntries())).toHaveLength(1);
    // 模拟崩溃：不走 abort（abort 会落 ama.aborted），直接丢掉进程内状态
    first.manager.close();
    first.session.abort().catch(() => undefined);
    await run.catch(() => undefined);
    const second = harness([{ text: "ok" }], { file });
    await second.session.prompt("continue again");
    expect(recoveryEntries(second.fileEntries())).toHaveLength(1);
    await second.session.dispose();
  });

  it("R3：会话写 ama.trace，最后一轮结果已落、没有 step → 提醒（清单不带 (no result)）", async () => {
    const h = harness(
      [{ toolCalls: [{ name: "bash", args: { command: "ls" } }] }, { text: "done" }],
      {
        extensions: [reminders, traceWriterFactory()],
      },
    );
    await h.session.prompt("start");
    await h.session.dispose();
    const file = h.manager.file() as string;
    const manager = SessionManager.open(file);
    manager.append({
      type: "message",
      message: { role: "user", content: "next", timestamp: Date.now() },
    });
    manager.append({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "y1", name: "bash", arguments: { command: "git commit -m x" } },
        ],
        api: "fake",
        provider: "fake",
        model: "echo",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    });
    manager.append({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "y1",
        toolName: "bash",
        content: "ok",
        isError: false,
        timestamp: Date.now(),
      },
    });
    manager.close();
    const resumed = harness([{ text: "ok" }], {
      file,
      extensions: [reminders, traceWriterFactory()],
    });
    await resumed.session.prompt("go on");
    const found = recoveryEntries(resumed.fileEntries());
    expect(found).toHaveLength(1);
    expect(String((found[0] as { content: unknown }).content)).toContain(
      "Tool calls in that turn: bash git.",
    );
    await resumed.session.dispose();
  });

  it("干净结束与 Esc 中断后 resume：不注入", async () => {
    const file = await cleanSession();
    const clean = harness([{ text: "ok" }], { file });
    await clean.session.prompt("next");
    expect(recoveryEntries(clean.fileEntries())).toHaveLength(0);
    await clean.session.dispose();

    const hanging = harness([
      { kind: "hang", toolCalls: [{ name: "bash", args: { command: "sleep 9" } }] },
    ]);
    const run = hanging.session.prompt("go");
    await until(hanging, (e) => e.type === "message_start" && e.message.role === "assistant");
    await hanging.session.abort();
    await run;
    await hanging.session.dispose();
    const interrupted = harness([{ text: "ok" }], { file: hanging.manager.file() as string });
    await interrupted.session.prompt("next");
    expect(recoveryEntries(interrupted.fileEntries())).toHaveLength(0);
    const roles = interrupted
      .fileEntries()
      .map((e) =>
        e.type === "message" ? e.message.role : e.type === "custom_message" ? e.customType : e.type,
      );
    expect(roles).toContain(ABORTED_CUSTOM_TYPE);
    await interrupted.session.dispose();
  });

  it("子会话（depth > 0）重开被打断的会话文件也拿到提醒", async () => {
    const file = await cleanSession();
    appendDangling(file, [{ id: "x1", name: "bash", args: { command: "gh pr create" } }]);
    const child = harness([{ text: "ok" }], { file, depth: 1 });
    await child.session.prompt("continue");
    const found = recoveryEntries(child.fileEntries());
    expect(found).toHaveLength(1);
    expect(String((found[0] as { content: unknown }).content)).toContain("bash gh (no result)");
    await child.session.dispose();
  });

  it("文本固定英文：两种界面语言逐字节相同；没有工具调用时另有一句", () => {
    const unclean: UncleanEnd = {
      reason: "dangling_tool_calls",
      tools: ["bash git (no result)", "edit a.ts"],
      more: 2,
      reminded: false,
    };
    setLocale("zh");
    const zh = recoveryReminderText(unclean);
    setLocale("en");
    const en = recoveryReminderText(unclean);
    expect(en).toBe(zh);
    expect(zh).toContain("bash git (no result); edit a.ts; …and 2 more.");
    expect(zh).not.toMatch(/[　-〿㐀-䶿一-鿿]/);
    const none = recoveryReminderText({ ...unclean, tools: [], more: 0 });
    expect(none).toContain("No tool calls were recorded in that turn.");
  });
});
