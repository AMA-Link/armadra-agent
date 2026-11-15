import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createHarness } from "../agent/testing/harness.js";
import { stubTool } from "../agent/testing/stubs.js";
import type { ToolDefinition } from "../tools/types.js";
import { sandboxEntryForTests } from "../../test/helpers/codemode-sandbox.js";
import { detectSandboxCapability } from "./capability.js";
import { prepareScriptImages } from "./script-images.js";
import { BOOTSTRAP, MAX_SCRIPT_IMAGES } from "./sandbox-entry.js";
import { createCodemodeTool, toScriptValue } from "./tool.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString(
  "base64",
);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1").toString("base64");
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([4, 0, 0, 0]),
  Buffer.from("WEBPVP8 "),
]).toString("base64");

/** 在引导脚本（两个引擎共用）里直接调 image()：成功给 `{ data, mimeType }`，失败给错误文本。 */
function normalizeImage(value: unknown): { data: string; mimeType: string } | string {
  const sent: { data: string; mimeType: string }[] = [];
  const context = createContext(Object.create(null) as object);
  const factory = new Script(BOOTSTRAP).runInContext(context) as (
    host: (kind: string, payload: string) => undefined,
    config: object,
  ) => unknown;
  factory(
    (kind, payload) => {
      if (kind === "image") sent.push(JSON.parse(payload) as { data: string; mimeType: string });
      return undefined;
    },
    {
      maxConcurrent: 8,
      maxValueChars: 1000,
      maxTotalChars: 1000,
      maxImages: 8,
      tools: "[]",
      store: "{}",
    },
  );
  const image = new Script("image").runInContext(context) as (v: unknown) => void;
  try {
    image(value);
  } catch (error) {
    return (error as Error).message;
  }
  return sent[0] as { data: string; mimeType: string };
}

describe("image() 入参规范化（引导脚本，两个引擎共用）", () => {
  it("四种格式按文件头认 MIME，声明的 MIME 被忽略", () => {
    expect(normalizeImage(`data:image/png;base64,${PNG}`)).toEqual({
      data: PNG,
      mimeType: "image/png",
    });
    expect(normalizeImage({ image_url: `data:image/gif;base64,${JPEG}` })).toEqual({
      data: JPEG,
      mimeType: "image/jpeg",
    });
    expect(normalizeImage({ image_url: { url: `data:image/png;base64,${GIF}` } })).toMatchObject({
      mimeType: "image/gif",
    });
    expect(normalizeImage({ type: "image", data: WEBP, mimeType: "image/png" })).toEqual({
      data: WEBP,
      mimeType: "image/webp",
    });
  });

  it("远程 URL、不是 base64、不是图片、形状不对都被拒", () => {
    expect(normalizeImage("https://example.com/a.png")).toContain("remote URLs");
    expect(normalizeImage({ image_url: "http://x/y.png" })).toContain("remote URLs");
    expect(normalizeImage("data:image/png,abc")).toContain("base64-encoded");
    expect(normalizeImage("data:image/png;base64,@@@")).toContain("not valid base64");
    expect(
      normalizeImage(`data:image/png;base64,${Buffer.from("plain text").toString("base64")}`),
    ).toContain("not a PNG");
    expect(normalizeImage(42)).toContain("pass a base64 data: URL");
    expect(normalizeImage({ type: "image" })).toContain("pass a base64 data: URL");
    expect(MAX_SCRIPT_IMAGES).toBe(8);
  });
});

describe("tools.read 的图片结果", () => {
  it("给脚本一个 image() 直接收的图片块", () => {
    const value = toScriptValue("read", {
      content: [
        { type: "text", text: "Image: a.png" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
    });
    expect(value).toEqual({ type: "image", data: PNG, mimeType: "image/png" });
    expect(normalizeImage(value)).toMatchObject({ mimeType: "image/png" });
  });
});

describe("prepareScriptImages（父进程再校验）", () => {
  it("按文件头重认 MIME、落盘并给出路径；声明成图片的非图片被跳过", async () => {
    const saved: string[] = [];
    const out = await prepareScriptImages(
      [
        { data: PNG, mimeType: "image/jpeg" },
        { data: Buffer.from("not an image").toString("base64"), mimeType: "image/png" },
      ],
      (_bytes, extension, n) => {
        saved.push(`${n}.${extension}`);
        return `/out/x-image-${n}.${extension}`;
      },
    );
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(saved).toEqual(["1.png"]);
    expect(out.notes).toEqual([
      "[Image 1 attached; saved to /out/x-image-1.png]",
      "[Image 2 skipped: not a PNG, JPEG, GIF or WebP image]",
    ]);
  });
});

describe("image() 会话内", () => {
  it("图片块附在结果后，文件落在 outputDir，结果文本写明路径；非法输入在脚本里抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ama-images-"));
    const read = stubTool({
      name: "read",
      run: () => ({
        content: [
          { type: "text", text: "Image: a.png" },
          { type: "image", data: PNG, mimeType: "image/png" },
        ],
      }),
    }) as ToolDefinition;
    const codemode = createCodemodeTool({
      listTools: () => [{ tool: read, textResult: true }],
      capability: detectSandboxCapability("26.0.0"),
      entry: sandboxEntryForTests(),
    }) as ToolDefinition;
    const h = createHarness({
      script: [
        {
          toolCalls: [
            {
              name: "codemode",
              id: "cm1",
              args: {
                script: `image(await tools.read({ path: "a.png" }));
                image("data:image/png;base64,${PNG}");
                try { image("https://example.com/a.png"); } catch (e) { text(e.message); }
                try { image({ type: "image", data: "AAAA" }); } catch (e) { text(e.message); }`,
              },
            },
          ],
        },
        { text: "ok" },
      ],
      tools: [codemode, read],
      activeTools: ["codemode"],
      outputDir: dir,
    });
    await h.session.prompt("go");
    const result = h.session.messages.find((m) => m.role === "toolResult");
    const blocks = result?.content as { type: string; text?: string; mimeType?: string }[];
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(2);
    const text = blocks.find((b) => b.type === "text")?.text ?? "";
    expect(text).toContain("remote URLs are not supported");
    expect(text).toContain("not a PNG, JPEG, GIF or WebP image");
    expect(text).toContain(`[Image 1 attached; saved to ${join(dir, "cm1-image-1.png")}]`);
    expect(existsSync(join(dir, "cm1-image-2.png"))).toBe(true);
    expect(readFileSync(join(dir, "cm1-image-1.png")).toString("base64")).toBe(PNG);
    rmSync(dir, { recursive: true, force: true });
  });
});
