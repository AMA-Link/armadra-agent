/**
 * [#318] contract.owns 的 glob 方言（多 Agent 工作流设计稿 §4.2、§5.7）：
 * `/` 分段；段内 `*`（不跨 `/`）与 `?` 是通配，其余字面；整段 `**` 匹配零到多段；结尾 `/` 等于 `/**`。
 * 纯函数，不 import 任何模块；属于 `./workflow` 入口。
 */

const FORBIDDEN_CHARS = ["{", "}", "[", "]", "!", "\\"] as const;

/** 返回非法原因；合法返回 undefined。不检查长度（上限在 `validateWorkflow`）。 */
export function validateOwnsGlob(glob: string): string | undefined {
  if (glob.length === 0) return "empty";
  if (glob.startsWith("/")) return "must not start with /";
  for (const ch of FORBIDDEN_CHARS) {
    if (glob.includes(ch)) return `unsupported character ${ch}`;
  }
  const segments = glob.split("/");
  // 结尾 `/` 产生一个空的末段，允许；其余空段（`a//b`）不允许。
  if (segments[segments.length - 1] === "") segments.pop();
  if (segments.length === 0) return "empty";
  for (const segment of segments) {
    if (segment === "") return "empty segment";
    if (segment === "..") return "must not contain a .. segment";
  }
  return undefined;
}

function segmentsOf(glob: string): string[] {
  const expanded = glob.endsWith("/") ? `${glob}**` : glob;
  return expanded.split("/");
}

/** 两个段模式（只含字面、`*`、`?`）的语言是否有交。 */
function segmentsOverlap(p: string, q: string): boolean {
  const memo = new Map<number, boolean>();
  const go = (x: number, y: number): boolean => {
    const key = x * (q.length + 1) + y;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    const px = p[x];
    const qy = q[y];
    if (px === undefined && qy === undefined) result = true;
    else if (px === "*") result = go(x + 1, y) || (qy !== undefined && go(x, y + 1));
    else if (qy === "*") result = go(x, y + 1) || (px !== undefined && go(x + 1, y));
    else if (px === undefined || qy === undefined) result = false;
    else result = (px === "?" || qy === "?" || px === qy) && go(x + 1, y + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/** 是否存在同时匹配两条 glob 的路径。 */
export function globsOverlap(a: string, b: string): boolean {
  const sa = segmentsOf(a);
  const sb = segmentsOf(b);
  const width = sb.length + 1;
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * width + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const x = sa[i];
    const y = sb[j];
    let result: boolean;
    if (x === undefined && y === undefined) result = true;
    else if (x === "**") result = go(i + 1, j) || (y !== undefined && go(i, j + 1));
    else if (y === "**") result = go(i, j + 1) || (x !== undefined && go(i + 1, j));
    else if (x === undefined || y === undefined) result = false;
    else result = segmentsOverlap(x, y) && go(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}
