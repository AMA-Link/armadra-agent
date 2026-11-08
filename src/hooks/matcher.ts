/**
 * Hook matcher（设计 §6.1「matcher」）。[B5]
 *
 * 语法：缺省 / 空串 / `*` 匹配全部；`bash` 精确；`write|edit` 多选；`canvas_*` glob；
 * `bash(git push*)` 先匹配工具名，再对参数文本做 glob；`/regex/flags` 对工具名做正则。
 * 括号内的文本：bash → `input.command`；文件类工具 → `input.path`（或 `file_path` / `pattern`）；
 * web_fetch → `input.url`（整个 URL，与权限规则的 `host/path` 语义不同）；其它工具 → 输入 JSON 文本。`|` 只在括号外分隔候选。只在 Pre/PostToolUse 生效。
 *
 * [#277] `read` 的括号文本若以 `scheme://` 开头，scheme 先转小写再 glob：dispatcher 已把已注册资源引用的
 * `path` 规范成小写 scheme，`read(DEMO://*)` 与 `read(demo://*)` 都命中 `DEMO://x` / `demo://x`（与权限规则
 * 对 pattern 的处理一致）。只动 scheme 部分，路径部分与普通路径 glob 仍区分大小写；其它工具不做此处理。
 */

export type ToolMatcher = (toolName: string, input: unknown) => boolean;

/** glob → 正则：`*` 任意字符串（含 `/`），`?` 单个字符，其余字面量。 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (const ch of glob) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += ch.replace(/[\\^$.+()|[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "s");
}

/** 括号外的 `|` 切分。 */
export function splitAlternatives(matcher: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of matcher) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "|" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** 括号内 glob 匹配的参数文本。 */
export function argumentText(toolName: string, input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    if (toolName === "bash" && typeof record["command"] === "string") return record["command"];
    for (const key of ["path", "file_path", "pattern", "url"]) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
  }
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "";
  }
}

const REGEX_FORM = /^\/(.+)\/([a-z]*)$/s;
const CALL_FORM = /^([^()]+)\((.*)\)$/s;
/** 资源引用形状的前缀（与 tools/resource-ref.ts 一致；hooks 不 import tools）。 */
const SCHEME_PREFIX_RE = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):\/\//;
/** 只有内置 `read` 读宿主资源。 */
const RESOURCE_TOOL = "read";

/** [#277] 括号文本以 `scheme://` 开头时把 scheme 转小写，其余原样。 */
function lowerSchemePrefix(text: string): string {
  return text.replace(SCHEME_PREFIX_RE, (_m, scheme: string) => `${scheme.toLowerCase()}://`);
}

function compileAlternative(alt: string, nameOnly = false): ToolMatcher {
  const regex = REGEX_FORM.exec(alt);
  if (regex !== null) {
    const re = new RegExp(regex[1] ?? "", (regex[2] ?? "").replace(/[gy]/g, ""));
    return (toolName) => re.test(toolName);
  }
  const call = CALL_FORM.exec(alt);
  if (call !== null) {
    const name = globToRegExp((call[1] ?? "").trim());
    const argText = (call[2] ?? "").trim();
    const arg = globToRegExp(argText);
    const loweredText = lowerSchemePrefix(argText);
    // read 用 scheme 小写化后的 pattern（已注册资源的 path 已被规范成小写 scheme）
    const argForRead = loweredText === argText ? arg : globToRegExp(loweredText);
    if (nameOnly) return (toolName) => name.test(toolName);
    return (toolName, input) =>
      name.test(toolName) &&
      (toolName === RESOURCE_TOOL ? argForRead : arg).test(argumentText(toolName, input));
  }
  const name = globToRegExp(alt);
  return (toolName) => name.test(toolName);
}

/**
 * 编译 matcher；语法错误（非法正则）抛 Error。
 * `nameOnly`：忽略括号参数，只看工具名（输入未知时判断「可能匹配」）。
 */
export function compileMatcher(matcher: string | undefined, nameOnly = false): ToolMatcher {
  if (matcher === undefined) return () => true;
  const trimmed = matcher.trim();
  if (trimmed === "" || trimmed === "*") return () => true;
  // 整串是正则时不按 `|` 切分（正则里的 `|` 是正则自己的）。
  if (REGEX_FORM.test(trimmed)) return compileAlternative(trimmed);
  const alternatives = splitAlternatives(trimmed).map((alt) => compileAlternative(alt, nameOnly));
  return (toolName, input) => alternatives.some((m) => m(toolName, input));
}

/** 校验 matcher 语法；返回错误信息或 undefined。 */
export function checkMatcher(matcher: string | undefined): string | undefined {
  try {
    compileMatcher(matcher);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}
