/**
 * 脚本内 `tools.bash` 的输出放宽（codemode 指南「返回值」）。
 *
 * 直接调用时 bash 的结果按会话上限尾截断（2000 行 / 50 KB），全文落在 `fullOutputPath`。脚本里要
 * 自己过滤、统计输出，这个上限太紧：`output` 放宽到 1 MiB；更长时保留首尾各 512 KiB，中间换成说明，
 * `truncated` 为真，全文仍在 `fullOutputPath`。只改脚本拿到的值，模型直接调用 bash 的结果不变。
 */

import { open } from "node:fs/promises";
import { sanitizeOutput } from "../tools/output-accumulator.js";

export const SCRIPT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
export const SCRIPT_OUTPUT_HALF_BYTES = SCRIPT_OUTPUT_LIMIT_BYTES / 2;

export interface LimitableBashValue {
  output: string;
  truncated: boolean;
  fullOutputPath?: string;
}

/** 从缓冲区头部取 UTF-8 文本，丢掉末尾被截断的半个字符。 */
function decodeHead(buffer: Buffer): string {
  let end = buffer.length;
  // 回退到最后一个完整字符之前：末尾若有不完整的多字节序列就整体丢掉
  let back = 0;
  while (back < 3 && end - back > 0 && ((buffer[end - back - 1] ?? 0) & 0xc0) === 0x80) back++;
  const lead = buffer[end - back - 1] ?? 0;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (need > back + 1) end = end - back - 1;
  return buffer.subarray(0, end).toString("utf8");
}

/** 从缓冲区尾部取 UTF-8 文本，丢掉开头的续字节。 */
function decodeTail(buffer: Buffer): string {
  let start = 0;
  while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

/**
 * bash 结果被直接调用的上限截过（`truncated` 且有全文文件）时，按脚本的上限重新取 `output`；读不到
 * 文件就原样返回。全文 ≤ 1 MiB 时 `output` 是全文、`truncated` 为假。
 */
export async function widenScriptBashOutput<T extends LimitableBashValue>(value: T): Promise<T> {
  const path = value.fullOutputPath;
  if (!value.truncated || path === undefined) return value;
  let handle;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    if (size <= SCRIPT_OUTPUT_LIMIT_BYTES) {
      const whole = Buffer.alloc(size);
      await handle.read(whole, 0, size, 0);
      return { ...value, output: sanitizeOutput(whole.toString("utf8")), truncated: false };
    }
    const head = Buffer.alloc(SCRIPT_OUTPUT_HALF_BYTES);
    const tail = Buffer.alloc(SCRIPT_OUTPUT_HALF_BYTES);
    await handle.read(head, 0, head.length, 0);
    await handle.read(tail, 0, tail.length, size - tail.length);
    const omitted = size - SCRIPT_OUTPUT_LIMIT_BYTES;
    const marker = `\n[... ${omitted} bytes omitted; full output: ${path} ...]\n`;
    return {
      ...value,
      output: `${sanitizeOutput(decodeHead(head))}${marker}${sanitizeOutput(decodeTail(tail))}`,
      truncated: true,
    };
  } catch {
    return value;
  } finally {
    await handle?.close().catch(() => {});
  }
}
