/**
 * 模型工具参数的宽松强转（设计 §5.1）。
 *
 * 只在严格校验失败之后调用一次：按 schema 关键字递归把「差一点」的参数改成合规形状，
 * 调用方再校验一次，通过才用强转后的参数；仍失败则回报原始参数的校验错误。
 *
 * 规则（均由 schema 驱动，不猜）：
 * - integer / number：严格十进制数字串（无空白、无十六进制、无 NaN / Infinity）→ 数字；integer 必须是整数。
 * - boolean：恰为 "true" / "false" 的字符串 → 布尔。
 * - string：有限数字、布尔 → 字符串。
 * - array：JSON 字符串解析为数组则采用；否则单个值包成 [value]（元素强转后须满足 items）。
 * - object：JSON 字符串解析为对象则采用。
 * - object 的可选属性值为 null 且该属性的 schema 不允许 null（enum 不含 null）→ 丢弃该属性。
 * - 带 enum 的 schema：强转结果必须与某个枚举值严格相等，否则保持原值；永不填 default。
 *
 * 纯函数，不修改入参；没有任何改动时 `changed` 为 false 且 `value` 就是入参本身。
 */

import { validateSchema, type JsonSchema } from "./schema.js";

export interface CoerceResult {
  value: unknown;
  changed: boolean;
}

const NUMBER_TEXT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string, kind: "object" | "array"): unknown {
  const trimmed = text.trim();
  if (trimmed[0] !== (kind === "object" ? "{" : "[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return kind === "object"
      ? isPlainObject(parsed)
        ? parsed
        : undefined
      : Array.isArray(parsed)
        ? parsed
        : undefined;
  } catch {
    return undefined;
  }
}

function coerceScalar(schema: JsonSchema, value: unknown): unknown {
  switch (schema.type) {
    case "number":
    case "integer": {
      if (typeof value !== "string" || !NUMBER_TEXT.test(value)) return value;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return value;
      if (schema.type === "integer" && !Number.isInteger(parsed)) return value;
      return parsed;
    }
    case "boolean":
      return value === "true" ? true : value === "false" ? false : value;
    case "string":
      return (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean"
        ? String(value)
        : value;
    default:
      return value;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b;
}

function coerceObject(schema: JsonSchema, value: Record<string, unknown>): CoerceResult {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  let out: Record<string, unknown> | undefined;
  for (const [key, child] of Object.entries(value)) {
    const childSchema = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (childSchema === undefined || child === undefined) continue;
    if (child === null) {
      if (!required.has(key) && childSchema.enum?.includes(null) !== true) {
        out ??= { ...value };
        delete out[key];
      }
      continue;
    }
    const result = coerceAt(childSchema, child);
    if (result.changed) {
      out ??= { ...value };
      out[key] = result.value;
    }
  }
  return out === undefined ? { value, changed: false } : { value: out, changed: true };
}

function coerceArray(schema: JsonSchema, value: unknown[]): CoerceResult {
  const items = schema.items;
  if (items === undefined) return { value, changed: false };
  let out: unknown[] | undefined;
  value.forEach((item, index) => {
    const result = coerceAt(items, item);
    if (result.changed) {
      out ??= [...value];
      out[index] = result.value;
    }
  });
  return out === undefined ? { value, changed: false } : { value: out, changed: true };
}

function coerceAt(schema: JsonSchema, value: unknown): CoerceResult {
  const unchanged: CoerceResult = { value, changed: false };
  if (value === undefined || value === null) return unchanged;
  let current: unknown = value;
  let changed = false;
  if (schema.type === "array" && !Array.isArray(current)) {
    const parsed = typeof current === "string" ? parseJson(current, "array") : undefined;
    if (parsed !== undefined) {
      current = parsed;
    } else {
      const element =
        schema.items === undefined ? { value: current } : coerceAt(schema.items, current);
      if (schema.items !== undefined && validateSchema(schema.items, element.value).length > 0) {
        return unchanged;
      }
      current = [element.value];
    }
    changed = true;
  } else if (schema.type === "object" && typeof current === "string") {
    const parsed = parseJson(current, "object");
    if (parsed === undefined) return unchanged;
    current = parsed;
    changed = true;
  } else if (schema.type !== undefined && schema.type !== "object" && schema.type !== "array") {
    current = coerceScalar(schema, current);
    changed = !Object.is(current, value);
  }
  if (Array.isArray(current)) {
    const inner = coerceArray(schema, current);
    current = inner.value;
    changed ||= inner.changed;
  } else if (
    isPlainObject(current) &&
    (schema.type === "object" || schema.properties !== undefined)
  ) {
    const inner = coerceObject(schema, current);
    current = inner.value;
    changed ||= inner.changed;
  }
  if (!changed) return unchanged;
  if (
    schema.enum !== undefined &&
    !schema.enum.some((candidate) => sameValue(candidate, current))
  ) {
    return unchanged;
  }
  return { value: current, changed: true };
}

/** 按 schema 强转一次；见文件头规则。 */
export function coerceArguments(schema: JsonSchema, value: unknown): CoerceResult {
  return coerceAt(schema, value);
}
