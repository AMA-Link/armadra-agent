/**
 * 异常中断后的恢复提醒（#268）：判定在 `session/unclean-end.ts`，这里只管「何时注入、注入什么」。
 *
 * - 会话构造时取样一次（`armed`）：文件刚打开、还没有新条目；新会话分支为空永不命中，运行中 `/tree`
 *   挪叶子也不会触发。
 * - 第一次 `beforePrompts` 时重新判定当前分支（resume 后先 `/compact`、`/tree` 仍能对上），仍不干净且
 *   T 里没有带 `details.recovery` 的提醒 → 给出正文；无论结果如何之后不再尝试。
 * - 文本固定英文，不 import i18n；经 `ama.reminder` 通道追加在尾部，系统提示与工具表不变。
 */

import type { SessionManager } from "../session/manager.js";
import { detectUncleanEnd, type UncleanEnd } from "../session/unclean-end.js";

/** 注入的 `custom_message{ama.reminder}` 的 `details`（判定据此识别「已提醒」）。 */
export const RECOVERY_DETAILS = { recovery: true } as const;

export function recoveryReminderText(unclean: UncleanEnd): string {
  const listed =
    unclean.tools.length === 0
      ? "No tool calls were recorded in that turn."
      : `Tool calls in that turn: ${unclean.tools.join("; ")}${
          unclean.more > 0 ? `; …and ${unclean.more} more` : ""
        }.`;
  return (
    "The previous turn of this session ended abruptly (the process stopped before the turn finished; " +
    `this was not a user interrupt). ${listed} ` +
    "Calls marked (no result) may or may not have taken effect. Before repeating any action with " +
    "external effects (pushes, PRs, comments, migrations, deployments, messages), inspect the workspace, " +
    "the git history and the external state to see what already happened, then continue from there. " +
    "Do not mention this reminder."
  );
}

export class RecoveryReminder {
  private armed: boolean;

  constructor(private readonly manager: SessionManager) {
    const found = detectUncleanEnd(manager.branch());
    this.armed = found !== undefined && !found.reminded;
  }

  /** 新提示前调用一次；返回要追加的提醒正文（只在第一次、且仍不干净时有）。 */
  take(): string | undefined {
    if (!this.armed) return undefined;
    this.armed = false;
    const found = detectUncleanEnd(this.manager.branch());
    if (found === undefined || found.reminded) return undefined;
    return recoveryReminderText(found);
  }
}
