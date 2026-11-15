import { describe, expect, it } from "vitest";
import { coerceArguments } from "./schema-coerce.js";
import type { JsonSchema } from "./schema.js";

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
});
const run = (schema: JsonSchema, value: unknown) => coerceArguments(schema, value);

describe("coerceArguments: 数字", () => {
  it("数字串转 number / integer", () => {
    const schema = obj({ a: { type: "integer" }, b: { type: "number" } });
    expect(run(schema, { a: "42", b: "-1.5e2" })).toEqual({
      value: { a: 42, b: -150 },
      changed: true,
    });
  });
  it.each(["", " ", " 1", "1 ", "0x10", "NaN", "Infinity", "1e999", "1,2", "abc"])(
    "拒绝 %j",
    (text) => {
      expect(run({ type: "number" }, text).changed).toBe(false);
    },
  );
  it("integer 不接受小数串", () => {
    expect(run({ type: "integer" }, "1.5").changed).toBe(false);
    expect(run({ type: "integer" }, "2.0").value).toBe(2);
  });
});

describe("coerceArguments: 布尔与字符串", () => {
  it("true / false 串转布尔，其它不动", () => {
    expect(run({ type: "boolean" }, "true").value).toBe(true);
    expect(run({ type: "boolean" }, "false").value).toBe(false);
    expect(run({ type: "boolean" }, "yes").changed).toBe(false);
    expect(run({ type: "boolean" }, "True").changed).toBe(false);
  });
  it("数字与布尔转字符串，非有限数不转", () => {
    expect(run({ type: "string" }, 7).value).toBe("7");
    expect(run({ type: "string" }, false).value).toBe("false");
    expect(run({ type: "string" }, Number.NaN).changed).toBe(false);
    expect(run({ type: "string" }, { a: 1 }).changed).toBe(false);
  });
});

describe("coerceArguments: 数组与对象", () => {
  it("单值包成数组，元素同时强转", () => {
    const schema: JsonSchema = { type: "array", items: { type: "integer" } };
    expect(run(schema, "3").value).toEqual([3]);
    expect(run(schema, "x").changed).toBe(false);
  });
  it("JSON 字符串解析为数组 / 对象", () => {
    expect(run({ type: "array", items: { type: "string" } }, '["a","b"]').value).toEqual([
      "a",
      "b",
    ]);
    expect(run(obj({ n: { type: "integer" } }), '{"n":"5"}').value).toEqual({ n: 5 });
    expect(run({ type: "object" }, "[1]").changed).toBe(false);
    expect(run({ type: "object" }, "{bad").changed).toBe(false);
  });
  it("递归进 properties 与 items", () => {
    const schema = obj({
      edits: { type: "array", items: obj({ line: { type: "integer" } }, ["line"]) },
    });
    expect(run(schema, { edits: [{ line: "1" }, { line: 2 }] }).value).toEqual({
      edits: [{ line: 1 }, { line: 2 }],
    });
  });
  it("不改入参", () => {
    const input = { a: "1" };
    run(obj({ a: { type: "integer" } }), input);
    expect(input).toEqual({ a: "1" });
  });
});

describe("coerceArguments: null 与 enum", () => {
  it("丢弃可选属性的 null，必填的保留", () => {
    const schema = obj({ a: { type: "string" }, b: { type: "string" } }, ["b"]);
    expect(run(schema, { a: null, b: null }).value).toEqual({ b: null });
  });
  it("enum 含 null 时不丢", () => {
    const schema = obj({ a: { enum: ["x", null] } });
    expect(run(schema, { a: null }).changed).toBe(false);
  });
  it("enum 必须严格匹配", () => {
    expect(run({ type: "string", enum: ["1", "2"] }, 1).value).toBe("1");
    expect(run({ type: "string", enum: ["a"] }, 1).changed).toBe(false);
    expect(run({ type: "integer", enum: [1, 2] }, "3").changed).toBe(false);
  });
  it("不填 default", () => {
    const schema = obj({ a: { type: "string", default: "x" } });
    expect(run(schema, {})).toEqual({ value: {}, changed: false });
  });
  it("无改动返回同一对象", () => {
    const input = { a: 1 };
    expect(run(obj({ a: { type: "integer" } }), input).value).toBe(input);
  });
});
