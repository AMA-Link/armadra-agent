/**
 * 异常结束判定（#268）：R1 悬空调用、R2 非人为中断、R3 回合没结束；干净 / Esc / error / toolResult 末尾 /
 * user 末尾不判；已有恢复提醒 → reminded；工具清单的目标与上限。
 */

import { describe, expect, it } from "vitest";
import type { Message } from "../ai/types.js";
import type { SessionEntry, SessionEntryInput } from "./types.js";
import {
  UNCLEAN_TARGET_MAX,
  UNCLEAN_TOOLS_MAX,
  detectUncleanEnd,
  toolTarget,
} from "./unclean-end.js";

function branchOf(inputs: readonly SessionEntryInput[]): SessionEntry[] {
  return inputs.map((input, i) => ({
    ...input,
    id: `e${i}`,
    parentId: i === 0 ? null : `e${i - 1}`,
    timestamp: new Date(i * 1000).toISOString(),
  })) as SessionEntry[];
}

const msg = (message: Message): SessionEntryInput => ({ type: "message", message });
const user = (content: string, origin?: string): SessionEntryInput =>
  msg({ role: "user", content, timestamp: 0, ...(origin === undefined ? {} : { origin }) });
const assistant = (
  calls: { id: string; name: string; args?: Record<string, unknown> }[],
  stopReason: "stop" | "toolUse" | "aborted" | "error" = calls.length > 0 ? "toolUse" : "stop",
): SessionEntryInput =>
  msg({
    role: "assistant",
    content: [
      { type: "text", text: "t" },
      ...calls.map((c) => ({
        type: "toolCall" as const,
        id: c.id,
        name: c.name,
        arguments: c.args ?? {},
      })),
    ],
    api: "fake",
    provider: "fake",
    model: "echo",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason,
    timestamp: 0,
  });
const result = (toolCallId: string, name = "bash"): SessionEntryInput =>
  msg({
    role: "toolResult",
    toolCallId,
    toolName: name,
    content: "ok",
    isError: false,
    timestamp: 0,
  });
const step: SessionEntryInput = {
  type: "custom",
  customType: "ama.trace",
  data: { kind: "step", attempt: 1 },
};
const aborted: SessionEntryInput = {
  type: "custom_message",
  customType: "ama.aborted",
  content: "interrupted",
  display: false,
};
const recoveryReminder: SessionEntryInput = {
  type: "custom_message",
  customType: "ama.reminder",
  content: "<system-reminder>...</system-reminder>",
  display: false,
  details: { recovery: true },
};
const plainReminder: SessionEntryInput = {
  type: "custom_message",
  customType: "ama.reminder",
  content: "<system-reminder>todo</system-reminder>",
  display: false,
};

describe("detectUncleanEnd：不干净", () => {
  it("R1：最后一条 assistant 的工具调用缺结果；清单列名字与目标、缺结果的标 (no result)", () => {
    const found = detectUncleanEnd(
      branchOf([
        user("go"),
        assistant([{ id: "a", name: "read", args: { path: "x.ts" } }]),
        result("a", "read"),
        assistant([
          { id: "b", name: "bash", args: { command: "  git   push origin main" } },
          { id: "c", name: "write", args: { path: "src/a.ts", content: "secret output" } },
        ]),
      ]),
    );
    expect(found).toEqual({
      reason: "dangling_tool_calls",
      tools: ["read", "bash git (no result)", "write src/a.ts (no result)"],
      more: 0,
      reminded: false,
    });
  });

  it("R1：一批里只落了一部分结果也算", () => {
    const found = detectUncleanEnd(
      branchOf([
        user("go"),
        assistant([
          { id: "a", name: "bash", args: { command: "ls" } },
          { id: "b", name: "bash", args: { command: "pwd" } },
        ]),
        result("a"),
      ]),
    );
    expect(found?.reason).toBe("dangling_tool_calls");
    expect(found?.tools).toEqual(["bash ls", "bash pwd (no result)"]);
  });

  it("R2：aborted 而没有 ama.aborted（SIGKILL 落在 abort 之后、recordAbort 之前）", () => {
    const found = detectUncleanEnd(branchOf([user("go"), assistant([], "aborted")]));
    expect(found?.reason).toBe("aborted_without_interrupt");
    expect(found?.tools).toEqual([]);
  });

  it("R3：会话在写 ama.trace，而最后一条 assistant 之后没有 step（结果已落、finishTurn 期间被杀）", () => {
    const found = detectUncleanEnd(
      branchOf([
        user("go"),
        assistant([{ id: "a", name: "bash", args: { command: "ls" } }]),
        result("a"),
        step,
        assistant([{ id: "b", name: "edit", args: { path: "b.ts" } }]),
        result("b", "edit"),
      ]),
    );
    expect(found?.reason).toBe("turn_not_ended");
    expect(found?.tools).toEqual(["bash ls", "edit b.ts"]);
  });

  it("清单只看最后一轮（最后一条非 steer 的 user 之后），steer 不切断；去重、封顶", () => {
    const many = Array.from({ length: UNCLEAN_TOOLS_MAX + 3 }, (_, i) => ({
      id: `c${i}`,
      name: "bash",
      args: { command: `cmd${i}` },
    }));
    const found = detectUncleanEnd(
      branchOf([
        user("first"),
        assistant([{ id: "old", name: "bash", args: { command: "old" } }]),
        result("old"),
        assistant([]),
        user("second"),
        assistant([{ id: "r", name: "read", args: { path: "a" } }]),
        result("r", "read"),
        user("hint", "steer"),
        assistant([{ id: "r2", name: "read", args: { path: "b" } }]),
        result("r2", "read"),
        assistant(many),
      ]),
    );
    expect(found?.tools[0]).toBe("read");
    expect(found?.tools).toHaveLength(UNCLEAN_TOOLS_MAX);
    expect(found?.more).toBe(many.length + 1 - UNCLEAN_TOOLS_MAX);
    expect(found?.tools.some((t) => t === "bash old")).toBe(false);
  });

  it("T 里已有带 details.recovery 的提醒 → reminded；普通提醒不算", () => {
    const base = [user("go"), assistant([{ id: "a", name: "bash", args: { command: "ls" } }])];
    expect(detectUncleanEnd(branchOf([...base, recoveryReminder]))?.reminded).toBe(true);
    expect(detectUncleanEnd(branchOf([...base, plainReminder]))?.reminded).toBe(false);
    // 下一次提示（user）也接在后面：仍是同一个异常结束
    expect(detectUncleanEnd(branchOf([...base, recoveryReminder, user("again")]))?.reminded).toBe(
      true,
    );
  });

  it("compaction / context_edit / model_change 等非消息条目不影响判定", () => {
    const found = detectUncleanEnd(
      branchOf([
        user("go"),
        assistant([{ id: "a", name: "bash", args: { command: "ls" } }]),
        { type: "model_change", provider: "fake", modelId: "echo" },
        { type: "compaction", summary: "s", firstKeptEntryId: "e0", tokensBefore: 1 },
        { type: "context_edit", targetId: "e1", replacement: null, reason: "manual" },
      ]),
    );
    expect(found?.reason).toBe("dangling_tool_calls");
  });
});

describe("detectUncleanEnd：干净", () => {
  it("没有 assistant / 空分支", () => {
    expect(detectUncleanEnd([])).toBeUndefined();
    expect(detectUncleanEnd(branchOf([user("go")]))).toBeUndefined();
  });

  it("正常收尾：assistant(stop) 在最后（有或没有 step）", () => {
    const calls = [{ id: "a", name: "bash", args: { command: "ls" } }];
    expect(
      detectUncleanEnd(branchOf([user("go"), assistant(calls), result("a"), assistant([])])),
    ).toBeUndefined();
    expect(
      detectUncleanEnd(
        branchOf([user("go"), assistant(calls), result("a"), step, assistant([]), step]),
      ),
    ).toBeUndefined();
  });

  it("Esc / interrupt：aborted + 补齐的结果 + ama.aborted", () => {
    expect(
      detectUncleanEnd(
        branchOf([
          user("go"),
          assistant([{ id: "a", name: "bash", args: { command: "ls" } }], "aborted"),
          result("a"),
          step,
          aborted,
        ]),
      ),
    ).toBeUndefined();
    // 工具执行中被中断：assistant 是 toolUse，结果是 aborted by user，再加 ama.aborted
    expect(
      detectUncleanEnd(
        branchOf([
          user("go"),
          assistant([{ id: "a", name: "bash", args: { command: "ls" } }]),
          result("a"),
          aborted,
        ]),
      ),
    ).toBeUndefined();
  });

  it("error 收尾、length：run 自己结束了", () => {
    expect(
      detectUncleanEnd(
        branchOf([
          user("go"),
          assistant([{ id: "a", name: "bash", args: { command: "ls" } }], "error"),
          result("a"),
        ]),
      ),
    ).toBeUndefined();
  });

  it("最后一条是 user（请求发出前被杀 / 树挪到 user）：本回合没有工具动作，不判", () => {
    expect(
      detectUncleanEnd(
        branchOf([
          user("go"),
          assistant([{ id: "a", name: "bash", args: { command: "ls" } }]),
          result("a"),
          assistant([]),
          user("next"),
        ]),
      ),
    ).toBeUndefined();
  });

  it("最后一条是 toolResult 且其后有 step（下一次请求中被杀，或 terminate / 预算到限的正常停止）：不判", () => {
    expect(
      detectUncleanEnd(
        branchOf([
          user("go"),
          assistant([{ id: "a", name: "bash", args: { command: "ls" } }]),
          result("a"),
          step,
        ]),
      ),
    ).toBeUndefined();
  });

  it("没有任何 step 的会话（没装轨迹写入）不启用 R3", () => {
    expect(
      detectUncleanEnd(
        branchOf([
          user("go"),
          assistant([{ id: "a", name: "bash", args: { command: "ls" } }]),
          result("a"),
        ]),
      ),
    ).toBeUndefined();
  });
});

describe("toolTarget", () => {
  it("bash 取第一个词，write / edit 取路径，其余没有目标；超长裁到上限", () => {
    expect(toolTarget("bash", { command: "git push origin main" })).toBe("git");
    expect(toolTarget("bash", { command: "   " })).toBeUndefined();
    expect(toolTarget("bash", { job: "bg1", action: "output" })).toBeUndefined();
    expect(toolTarget("write", { path: "a/b.ts", content: "x" })).toBe("a/b.ts");
    expect(toolTarget("edit", { path: "" })).toBeUndefined();
    expect(toolTarget("read", { path: "a" })).toBeUndefined();
    expect(toolTarget("task", { prompt: "do" })).toBeUndefined();
    const long = toolTarget("write", { path: "p".repeat(UNCLEAN_TARGET_MAX + 20) }) as string;
    expect(long).toHaveLength(UNCLEAN_TARGET_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});
