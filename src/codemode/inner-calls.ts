/**
 * 脚本内层调用的落盘记录（恢复用）。
 *
 * 脚本跑几分钟、中途进程被杀时，转录里只有外层 `codemode` 调用悬空，已经执行完的内层调用（写了文件、
 * 推了分支）不在任何地方。每个内层调用完成后追加一条 `custom{customType:"ama.codemode-call"}`
 * （不进上下文）：外层调用 id、工具名、目标（与恢复提醒共用 `toolTarget`，bash 只取命令第一个词、
 * 不带参数与结果正文）、是否成功。`session/unclean-end.ts` 在外层调用没有结果时把它们列进恢复提醒。
 * 只记已完成的；被脚本结束取消的不记。记录失败不影响调用本身。
 */

import { toolTarget } from "../session/unclean-end.js";
import type { ToolContext } from "../tools/types.js";

export const INNER_CALL_CUSTOM_TYPE = "ama.codemode-call";

export interface InnerCallData {
  /** 外层 `codemode` 调用的 toolCallId。 */
  parent: string;
  name: string;
  target?: string;
  ok: boolean;
}

export function recordInnerCall(
  session: ToolContext["session"],
  parent: string,
  name: string,
  args: unknown,
  ok: boolean,
): void {
  try {
    const record =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const target = toolTarget(name, record);
    const data: InnerCallData = { parent, name, ok, ...(target !== undefined ? { target } : {}) };
    session.appendCustom(INNER_CALL_CUSTOM_TYPE, data);
  } catch {
    // 记录只用于恢复提醒，不能让调用失败
  }
}
