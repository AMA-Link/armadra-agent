/**
 * 脚本里的 `searchTools(query, { limit?, namespace? })`：在可调用工具里按 BM25（名字 + 描述）排序。
 *
 * 工具很多时（宿主注册了一批 `canvas_*` 之类），描述里放不下全部声明，脚本先搜再用
 * `describeTool(name)` 取签名。纯函数，每次调用现建索引（工具几十个，微秒级）。
 */

export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 50;
/** 结果里描述的字符上限。 */
export const SEARCH_DESCRIPTION_CHARS = 240;
const K1 = 1.2;
const B = 0.75;

export interface SearchableTool {
  name: string;
  description: string;
}

export interface SearchToolsOptions {
  limit?: number;
  /** 工具名的前缀（`_` `.` `:` `-` 之前的部分），例如 `canvas` 匹配 `canvas_add`。 */
  namespace?: string;
}

export interface SearchHit {
  name: string;
  description: string;
}

/** 小写，按非字母数字切词，驼峰也切开；`read_file` → read / file。 */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "");
}

function inNamespace(name: string, namespace: string): boolean {
  const prefix = namespace.toLowerCase();
  const lower = name.toLowerCase();
  if (!lower.startsWith(prefix)) return false;
  const next = lower[prefix.length];
  return next === undefined || /[_.:-]/.test(next);
}

function shorten(description: string): string {
  const firstParagraph = description.trim().split(/\n\s*\n/, 1)[0] ?? "";
  const oneLine = firstParagraph.replace(/\s+/g, " ");
  return oneLine.length > SEARCH_DESCRIPTION_CHARS
    ? `${oneLine.slice(0, SEARCH_DESCRIPTION_CHARS - 1)}…`
    : oneLine;
}

/** 参数检查失败抛 TypeError（消息给脚本）；没有命中返回空数组。 */
export function searchTools(
  tools: readonly SearchableTool[],
  query: unknown,
  options: unknown = {},
): SearchHit[] {
  if (typeof query !== "string") throw new TypeError("searchTools(query): query must be a string");
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("searchTools(query, options): options must be an object");
  }
  const { limit: rawLimit, namespace } = options as SearchToolsOptions;
  if (
    rawLimit !== undefined &&
    (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1)
  ) {
    throw new TypeError("searchTools: limit must be a positive integer");
  }
  if (namespace !== undefined && typeof namespace !== "string") {
    throw new TypeError("searchTools: namespace must be a string");
  }
  const limit = Math.min(rawLimit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const pool = tools.filter(
    (tool) => namespace === undefined || namespace === "" || inNamespace(tool.name, namespace),
  );
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || pool.length === 0) return [];

  const docs = pool.map((tool) => ({ tool, terms: tokenize(`${tool.name} ${tool.description}`) }));
  const avgLength = docs.reduce((sum, doc) => sum + doc.terms.length, 0) / docs.length || 1;
  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.terms)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }
  const scored = docs.map((doc, index) => {
    const counts = new Map<string, number>();
    for (const term of doc.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) continue;
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.terms.length) / avgLength));
    }
    return { tool: doc.tool, score, index };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name) || a.index - b.index,
    )
    .slice(0, limit)
    .map(({ tool }) => ({ name: tool.name, description: shorten(tool.description) }));
}
