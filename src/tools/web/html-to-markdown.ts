/**
 * HTML → Markdown（`web_fetch` 用，零依赖）。宽松的分词 + 轻量树，不做完整 HTML5 解析：
 *
 * - 丢弃 `script` / `style` / `noscript` / `svg` / `template` / `iframe` / `nav` / `footer` / `aside` /
 *   `form` / `button` 及其内容，`<!-- -->` 注释与 `<head>`（标题单独取 `<title>`）；
 * - 正文优先 `<main>`，其次 `<article>`、`role="main"`，再次 `<body>`；
 * - 保留标题、段落、列表（嵌套缩进）、链接（`[文字](绝对 URL)`，`javascript:` 只留文字）、行内代码与
 *   `<pre>` 代码块（`language-xxx` 类名作语言）、引用、简单表格、`<br>` / `<hr>`；图片只留 alt；
 * - 实体：常用命名实体 + 十进制 / 十六进制数字实体；非 `<pre>` 文本折叠空白。
 *
 * 输出只依赖输入，便于黄金测试。
 */

export interface HtmlConversion {
  title?: string;
  markdown: string;
}

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: (Node | string)[];
  parent?: Node;
}

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noscript"]);
const DROP = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "math",
  "template",
  "iframe",
  "nav",
  "footer",
  "aside",
  "form",
  "button",
  "select",
  "textarea",
  "head",
  "title",
  "canvas",
  "object",
  "dialog",
]);
const BLOCK = new Set([
  "address",
  "article",
  "blockquote",
  "body",
  "center",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "html",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);
/** 打开这些标签时，先关掉还开着的同类（`<li>`、`<p>` 等常省略结束标签）。 */
const AUTO_CLOSE: Record<string, readonly string[]> = {
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr"],
  td: ["td", "th"],
  th: ["td", "th"],
  option: ["option"],
};
const CLOSES_P = new Set([
  "p",
  ...[...BLOCK].filter((t) => !["li", "td", "th", "dd", "dt"].includes(t)),
]);
/** 自动关闭不越过这些容器（嵌套列表、表格）。 */
const SCOPE = new Set(["ul", "ol", "dl", "table", "html", "body"]);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  times: "×",
  divide: "÷",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  rArr: "⇒",
  lArr: "⇐",
  le: "≤",
  ge: "≥",
  ne: "≠",
  plusmn: "±",
  minus: "−",
  shy: "",
  zwj: "",
  zwnj: "",
  thinsp: " ",
  ensp: " ",
  emsp: " ",
  check: "✓",
};

/** 解码字符实体。 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      )
        return "\uFFFD";
      return String.fromCodePoint(code);
    }
    const hit = ENTITIES[body] ?? ENTITIES[body.toLowerCase()];
    return hit ?? whole;
  });
}

const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of text.matchAll(ATTR_RE)) {
    const name = (m[1] as string).toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** 宽松解析成树。 */
export function parseHtml(html: string): Node {
  const root: Node = { tag: "#root", attrs: {}, children: [] };
  let cur = root;
  const open = (tag: string): Node | undefined => {
    for (let n: Node | undefined = cur; n !== undefined; n = n.parent) if (n.tag === tag) return n;
    return undefined;
  };
  const closeTo = (node: Node) => {
    cur = node.parent ?? root;
  };
  /** 从当前节点往上找还开着的 `tags` 之一并关掉；先碰到 `stop` 里的标签就作罢。 */
  const closeOpen = (tags: readonly string[], stop: ReadonlySet<string>) => {
    for (let n: Node | undefined = cur; n !== undefined && n !== root; n = n.parent) {
      if (tags.includes(n.tag)) return closeTo(n);
      if (stop.has(n.tag)) return;
    }
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      cur.children.push(html.slice(i));
      break;
    }
    if (lt > i) cur.children.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(
      html.slice(lt, lt + 8192),
    );
    if (m === null) {
      cur.children.push("<");
      i = lt + 1;
      continue;
    }
    i = lt + m[0].length;
    const tag = (m[2] as string).toLowerCase();
    if (m[1] === "/") {
      const node = open(tag);
      if (node !== undefined) closeTo(node);
      continue;
    }
    if (CLOSES_P.has(tag)) closeOpen(["p"], BLOCK);
    const siblings = AUTO_CLOSE[tag];
    if (siblings !== undefined) closeOpen(siblings, SCOPE);
    const node: Node = { tag, attrs: parseAttrs(m[3] as string), children: [], parent: cur };
    cur.children.push(node);
    if (RAW_TEXT.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, i);
      const body = html.slice(i, end === -1 ? html.length : end);
      node.children.push(body);
      const close = end === -1 ? -1 : html.indexOf(">", end);
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3] as string)) cur = node;
  }
  return root;
}

function find(node: Node, test: (n: Node) => boolean): Node | undefined {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (test(child)) return child;
    if (DROP.has(child.tag)) continue;
    const hit = find(child, test);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function rawText(node: Node): string {
  return node.children.map((c) => (typeof c === "string" ? c : rawText(c))).join("");
}

interface RenderContext {
  base: URL | undefined;
  listDepth: number;
}

function resolveHref(href: string, base: URL | undefined): string | undefined {
  const value = href.trim();
  if (value === "" || /^(javascript|data|vbscript):/i.test(value)) return undefined;
  if (value.startsWith("#")) return undefined;
  try {
    return base === undefined ? new URL(value).href : new URL(value, base).href;
  } catch {
    return undefined;
  }
}

function collapse(text: string): string {
  return decodeEntities(text).replace(/[\s\u00a0]+/g, " ");
}

function inline(node: Node, ctx: RenderContext): string {
  let out = "";
  for (const child of node.children) {
    if (typeof child === "string") out += collapse(child);
    else out += renderInline(child, ctx);
  }
  return out;
}

function wrap(mark: string, text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return text;
  const lead = text.startsWith(" ") ? " " : "";
  const trail = text.endsWith(" ") ? " " : "";
  return `${lead}${mark}${trimmed}${mark}${trail}`;
}

function renderInline(node: Node, ctx: RenderContext): string {
  if (DROP.has(node.tag)) return "";
  switch (node.tag) {
    case "br":
      return "\n";
    case "img": {
      const alt = (node.attrs["alt"] ?? "").trim();
      return alt === "" ? "" : collapse(alt);
    }
    case "a": {
      const text = inline(node, ctx);
      const href = resolveHref(node.attrs["href"] ?? "", ctx.base);
      if (href === undefined || text.trim() === "") return text;
      return `[${text.trim().replace(/[[\]]/g, "\\$&")}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
    }
    case "code":
    case "kbd":
    case "samp":
    case "tt": {
      const text = decodeEntities(rawText(node)).replace(/\s+/g, " ");
      if (text.trim() === "") return text;
      const fence = text.includes("`") ? "``" : "`";
      return `${fence}${text}${fence}`;
    }
    case "strong":
    case "b":
      return wrap("**", inline(node, ctx));
    case "em":
    case "i":
      return wrap("*", inline(node, ctx));
    case "del":
    case "s":
      return wrap("~~", inline(node, ctx));
    default:
      return BLOCK.has(node.tag) ? `\n\n${blocks(node, ctx)}\n\n` : inline(node, ctx);
  }
}

/** 子节点渲染成块序列（块之间空一行）。 */
function blocks(node: Node, ctx: RenderContext): string {
  const parts: string[] = [];
  let run = "";
  const flush = () => {
    const text = run
      .split("\n")
      .map((l) => l.replace(/ {2,}/g, " ").trim())
      .join("\n")
      .trim();
    if (text !== "") parts.push(text);
    run = "";
  };
  for (const child of node.children) {
    if (typeof child === "string") {
      run += collapse(child);
      continue;
    }
    if (DROP.has(child.tag)) continue;
    if (BLOCK.has(child.tag)) {
      flush();
      const text = renderBlock(child, ctx);
      if (text.trim() !== "") parts.push(text);
    } else run += renderInline(child, ctx);
  }
  flush();
  return parts.join("\n\n");
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, i) =>
      line === "" ? (i === 0 ? first.trimEnd() : "") : `${i === 0 ? first : rest}${line}`,
    )
    .join("\n");
}

function renderList(node: Node, ctx: RenderContext): string {
  const ordered = node.tag === "ol";
  let n = Number(node.attrs["start"] ?? "1");
  if (!Number.isFinite(n)) n = 1;
  const items: string[] = [];
  const inner: RenderContext = { ...ctx, listDepth: ctx.listDepth + 1 };
  for (const child of node.children) {
    if (typeof child === "string" || DROP.has(child.tag)) continue;
    const body = child.tag === "li" ? blocks(child, inner) : renderBlock(child, inner);
    if (body.trim() === "") continue;
    const marker = ordered ? `${n++}. ` : "- ";
    items.push(prefixLines(body.replace(/\n{2,}/g, "\n"), marker, " ".repeat(marker.length)));
  }
  return items.join("\n");
}

function cellText(node: Node, ctx: RenderContext): string {
  return blocks(node, ctx)
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function renderTable(node: Node, ctx: RenderContext): string {
  const rows: { cells: string[]; header: boolean }[] = [];
  const walk = (n: Node) => {
    for (const child of n.children) {
      if (typeof child === "string" || DROP.has(child.tag)) continue;
      if (child.tag === "tr") {
        const cells = child.children.filter(
          (c): c is Node => typeof c !== "string" && (c.tag === "td" || c.tag === "th"),
        );
        if (cells.length > 0)
          rows.push({
            cells: cells.map((c) => cellText(c, ctx)),
            header: n.tag === "thead" || cells.every((c) => c.tag === "th"),
          });
      } else if (child.tag !== "table") walk(child);
    }
  };
  walk(node);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.cells.length));
  const line = (cells: string[]) =>
    `| ${[...cells, ...new Array<string>(width - cells.length).fill("")].join(" | ")} |`;
  const headerIndex = rows[0]?.header === true ? 0 : -1;
  const head =
    headerIndex === 0
      ? (rows.shift() as { cells: string[] }).cells
      : new Array<string>(width).fill("");
  return [line(head), `|${" --- |".repeat(width)}`, ...rows.map((r) => line(r.cells))].join("\n");
}

function renderBlock(node: Node, ctx: RenderContext): string {
  switch (node.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = inline(node, ctx).replace(/\s+/g, " ").trim();
      return text === "" ? "" : `${"#".repeat(Number(node.tag[1]))} ${text}`;
    }
    case "hr":
      return "---";
    case "pre": {
      const code = find(node, (n) => n.tag === "code");
      const cls = `${code?.attrs["class"] ?? ""} ${node.attrs["class"] ?? ""}`;
      const lang = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(cls)?.[1] ?? "";
      const text = decodeEntities(rawText(node)).replace(/^\n/, "").replace(/\s+$/, "");
      const fence = text.includes("```") ? "~~~~" : "```";
      return `${fence}${lang}\n${text}\n${fence}`;
    }
    case "blockquote":
      return prefixLines(blocks(node, ctx), "> ", "> ");
    case "ul":
    case "ol":
      return renderList(node, ctx);
    case "table":
      return renderTable(node, ctx);
    default:
      return blocks(node, ctx);
  }
}

/** 页面标题：`<title>`，没有时取第一个 `<h1>`。 */
function pageTitle(root: Node): string | undefined {
  const title = find(root, (n) => n.tag === "title") ?? findIn(root, "title");
  const text = title !== undefined ? collapse(rawText(title)).trim() : "";
  if (text !== "") return text;
  const h1 = find(root, (n) => n.tag === "h1");
  const heading = h1 !== undefined ? collapse(rawText(h1)).trim() : "";
  return heading === "" ? undefined : heading;
}

/** 在丢弃的子树（`<head>`）里也找。 */
function findIn(node: Node, tag: string): Node | undefined {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (child.tag === tag) return child;
    const hit = findIn(child, tag);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** HTML 全文 → `{ title, markdown }`。`baseUrl` 用来把相对链接变成绝对 URL。 */
export function htmlToMarkdown(html: string, baseUrl?: string): HtmlConversion {
  const root = parseHtml(html);
  let base: URL | undefined;
  try {
    const declared = findIn(root, "base")?.attrs["href"];
    base = baseUrl === undefined ? undefined : new URL(declared ?? "", baseUrl);
  } catch {
    base = baseUrl === undefined ? undefined : new URL(baseUrl);
  }
  const main =
    find(root, (n) => n.tag === "main") ??
    find(root, (n) => n.tag === "article") ??
    find(root, (n) => n.attrs["role"] === "main") ??
    find(root, (n) => n.tag === "body") ??
    root;
  const markdown = blocks(main, { base, listDepth: 0 })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const title = pageTitle(root);
  return title === undefined ? { markdown } : { title, markdown };
}

/** `<meta charset>` / `http-equiv` 里声明的编码（只看前 2 KB）。 */
export function sniffMetaCharset(head: string): string | undefined {
  const text = head.slice(0, 2048);
  const direct = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(text);
  return direct?.[1]?.toLowerCase();
}
