/**
 * 脚本里 `image(v)` 产出的图片 → 工具结果里的图片块（父进程侧）。
 *
 * 子进程已按文件头校验过，但父进程不信任它：再按文件头认一遍 MIME（只认 PNG / JPEG / GIF / WebP，
 * 声明的 MIME 一律忽略），再按端点的单图上限检查；每张通过的图既作为图片块附在结果后面，也存成
 * `<outputDir>/<toolCallId>-image-<n>.<ext>`（与超长文本同目录），路径写进结果文本。
 */

import { internImage } from "../ai/image-intern.js";
import type { ImageBlock } from "../ai/types.js";
import { fitImage, sniffImageMime } from "../tools/image-file.js";

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export interface PreparedImages {
  blocks: ImageBlock[];
  /** 追加到结果文本的说明行（保存路径、被跳过的原因）。 */
  notes: string[];
  paths: string[];
}

export async function prepareScriptImages(
  images: readonly { data: string; mimeType: string }[],
  save: (bytes: Buffer, extension: string, index: number) => string | undefined,
): Promise<PreparedImages> {
  const out: PreparedImages = { blocks: [], notes: [], paths: [] };
  for (const [i, image] of images.entries()) {
    const n = i + 1;
    const bytes = Buffer.from(image.data, "base64");
    const mimeType = sniffImageMime(bytes);
    if (mimeType === undefined) {
      out.notes.push(`[Image ${n} skipped: not a PNG, JPEG, GIF or WebP image]`);
      continue;
    }
    const fit = await fitImage(bytes, mimeType);
    if (!fit.ok) {
      out.notes.push(`[Image ${n} skipped: ${fit.note}]`);
      continue;
    }
    out.blocks.push(
      internImage({ type: "image", data: fit.buf.toString("base64"), mimeType: fit.mimeType }),
    );
    const path = save(fit.buf, EXTENSIONS[fit.mimeType] ?? "bin", n);
    if (path !== undefined) out.paths.push(path);
    out.notes.push(
      path === undefined ? `[Image ${n} attached]` : `[Image ${n} attached; saved to ${path}]`,
    );
  }
  return out;
}
