/**
 * ACP 提示内容块 → Pi `prompt` 命令的 `message` 与 `images`（#254）。
 *
 * 文本与嵌入资源拼成一条 message（资源包在 `<resource uri>` 里，链接写成 `@uri`），图片走 `images`；
 * 音频块 Pi 没有对应入口，忽略。
 */

import type { AcpContentBlock } from "../../drivers/acp/types.js";
import { RPC_ERRORS } from "../../drivers/acp/types.js";
import { RpcError } from "../../drivers/jsonrpc.js";
import { msg } from "../../i18n/index.js";
import type { Json } from "./tools.js";

export function promptCommand(blocks: unknown): Json {
  if (!Array.isArray(blocks))
    throw new RpcError(RPC_ERRORS.invalidParams, msg().bridge.session.promptNotArray);
  const parts: string[] = [];
  const images: Json[] = [];
  for (const block of blocks as AcpContentBlock[]) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image")
      images.push({ type: "image", data: block.data, mimeType: block.mimeType });
    else if (block.type === "resource_link") parts.push(`@${block.uri}`);
    else if (block.type === "resource" && typeof block.resource.text === "string")
      parts.push(`<resource uri="${block.resource.uri}">\n${block.resource.text}\n</resource>`);
  }
  return { type: "prompt", message: parts.join("\n"), ...(images.length > 0 ? { images } : {}) };
}
