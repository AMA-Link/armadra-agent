import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCRIPT_OUTPUT_HALF_BYTES,
  SCRIPT_OUTPUT_LIMIT_BYTES,
  widenScriptBashOutput,
} from "./script-output.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fileWith(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ama-script-output-"));
  dirs.push(dir);
  const path = join(dir, "bash.log");
  writeFileSync(path, text);
  return path;
}

describe("脚本内 bash 输出放宽", () => {
  it("没有被截断：原样返回", async () => {
    const value = { output: "ok", truncated: false };
    expect(await widenScriptBashOutput(value)).toBe(value);
  });

  it("被直接调用的上限截过但全文 ≤ 1 MiB：output 取全文，truncated 为假", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const result = await widenScriptBashOutput({
      output: "tail only",
      truncated: true,
      fullOutputPath: fileWith(lines),
    });
    expect(result.output).toBe(lines);
    expect(result.truncated).toBe(false);
  });

  it("超过 1 MiB：保留首尾各 512 KiB，中间是说明，truncated 为真且指向全文", async () => {
    const body = `A${"a".repeat(SCRIPT_OUTPUT_HALF_BYTES * 2 + 1000)}Z`;
    const path = fileWith(body);
    const result = await widenScriptBashOutput({
      output: "x",
      truncated: true,
      fullOutputPath: path,
    });
    const omitted = body.length - SCRIPT_OUTPUT_LIMIT_BYTES;
    expect(result.truncated).toBe(true);
    expect(result.fullOutputPath).toBe(path);
    expect(result.output.startsWith("Aaaa")).toBe(true);
    expect(result.output.endsWith("aaaZ")).toBe(true);
    expect(result.output).toContain(`[... ${omitted} bytes omitted; full output: ${path} ...]`);
    expect(Buffer.byteLength(result.output)).toBeLessThan(SCRIPT_OUTPUT_LIMIT_BYTES + 300);
  });

  it("切点落在多字节字符中间时不产生乱码", async () => {
    const body = "你".repeat(SCRIPT_OUTPUT_LIMIT_BYTES / 2);
    const result = await widenScriptBashOutput({
      output: "x",
      truncated: true,
      fullOutputPath: fileWith(body),
    });
    expect(result.output).not.toContain("�");
  });

  it("全文文件读不到：保持原值", async () => {
    const value = { output: "tail", truncated: true, fullOutputPath: "/nonexistent/ama.log" };
    expect(await widenScriptBashOutput(value)).toEqual(value);
  });
});
