// A small YAML subset for workflow frontmatter. Pure functions, no imports.
//
// Supported: block mappings, block sequences (items may be mappings or
// sequences), inline flow `[a, "b"]` and `{k: v}` (including `[]` and `{}`),
// literal and folded block scalars (`|`, `|-`, `>`, `>-`), single and double
// quoted strings, `#` comments, integers, decimals, booleans and null.
// Rejected with a line number: anchors, aliases, tags, multiple documents,
// tab indentation, keep-chomping and indentation indicators, multi-line
// plain scalars, duplicate keys.

export type YamlValue =
  string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export interface YamlError {
  line: number;
  message: string;
}

class YamlSyntaxError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

interface PeekedLine {
  indent: number;
  text: string;
  no: number;
}

const COMMENT_OR_EMPTY = /^\s*(#.*)?$/;
const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

function resolvePlain(s: string): YamlValue {
  if (s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (NUMBER.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

function isSeqItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function setKey(target: { [key: string]: YamlValue }, key: string, value: YamlValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  '"': '"',
  "\\": "\\",
  "/": "/",
  " ": " ",
  b: "\b",
  f: "\f",
  e: "\u001b",
};

// Reads a quoted scalar starting at `start`; returns the value and the index after the closing quote.
function readQuoted(s: string, start: number, no: number): [string, number] {
  const quote = s[start];
  let out = "";
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return [out, i + 1];
      }
      out += c;
      i += 1;
      continue;
    }
    if (c === '"') return [out, i + 1];
    if (c !== "\\") {
      out += c;
      i += 1;
      continue;
    }
    const e = s[i + 1];
    if (e === "x" || e === "u") {
      const width = e === "x" ? 2 : 4;
      const hex = s.slice(i + 2, i + 2 + width);
      if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex))
        throw new YamlSyntaxError(no, "invalid escape sequence");
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2 + width;
      continue;
    }
    if (e === undefined || !(e in ESCAPES))
      throw new YamlSyntaxError(no, "invalid escape sequence");
    out += ESCAPES[e];
    i += 2;
  }
  throw new YamlSyntaxError(no, "unterminated quoted string");
}

function skipWs(s: string, i: number): number {
  let j = i;
  while (j < s.length && (s[j] === " " || s[j] === "\t")) j += 1;
  return j;
}

const MAX_DEPTH = 64;

function tooDeep(no: number): YamlSyntaxError {
  return new YamlSyntaxError(no, "nesting too deep");
}

function stripComment(s: string): string {
  for (let i = 1; i < s.length; i += 1) {
    if (s[i] === "#" && /\s/.test(s[i - 1] ?? "")) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function flowValue(s: string, from: number, no: number, depth = 0): [YamlValue, number] {
  if (depth >= MAX_DEPTH) throw tooDeep(no);
  let i = skipWs(s, from);
  const c = s[i];
  if (c === undefined) throw new YamlSyntaxError(no, "unexpected end of flow collection");
  if (c === "[") {
    const items: YamlValue[] = [];
    i += 1;
    for (;;) {
      i = skipWs(s, i);
      if (s[i] === "]") return [items, i + 1];
      const [v, next] = flowValue(s, i, no, depth + 1);
      items.push(v);
      i = skipWs(s, next);
      if (s[i] === ",") i += 1;
      else if (s[i] === "]") return [items, i + 1];
      else
        throw new YamlSyntaxError(
          no,
          s[i] === undefined ? "unterminated flow sequence" : "expected ',' or ']'",
        );
    }
  }
  if (c === "{") {
    const out: { [key: string]: YamlValue } = {};
    i += 1;
    for (;;) {
      i = skipWs(s, i);
      if (s[i] === "}") return [out, i + 1];
      let key: string;
      if (s[i] === '"' || s[i] === "'") {
        [key, i] = readQuoted(s, i, no);
      } else {
        let j = i;
        while (
          j < s.length &&
          s[j] !== "," &&
          s[j] !== "}" &&
          !(s[j] === ":" && (j + 1 >= s.length || " ,}".includes(s[j + 1] ?? "")))
        )
          j += 1;
        key = s.slice(i, j).trim();
        i = j;
      }
      i = skipWs(s, i);
      if (s[i] !== ":") throw new YamlSyntaxError(no, "expected ':' in flow mapping");
      i = skipWs(s, i + 1);
      if (Object.prototype.hasOwnProperty.call(out, key))
        throw new YamlSyntaxError(no, `duplicate key "${key}"`);
      if (s[i] === "," || s[i] === "}") {
        setKey(out, key, null);
      } else {
        const [v, next] = flowValue(s, i, no, depth + 1);
        setKey(out, key, v);
        i = next;
      }
      i = skipWs(s, i);
      if (s[i] === ",") i += 1;
      else if (s[i] === "}") return [out, i + 1];
      else
        throw new YamlSyntaxError(
          no,
          s[i] === undefined ? "unterminated flow mapping" : "expected ',' or '}'",
        );
    }
  }
  if (c === '"' || c === "'") return readQuoted(s, i, no);
  if (c === "&" || c === "*")
    throw new YamlSyntaxError(no, "anchors and aliases are not supported");
  if (c === "!") throw new YamlSyntaxError(no, "tags are not supported");
  let j = i;
  while (j < s.length && s[j] !== "," && s[j] !== "]" && s[j] !== "}") j += 1;
  const text = s.slice(i, j).trim();
  if (text === "") throw new YamlSyntaxError(no, "empty flow item");
  return [resolvePlain(text), j];
}

// Splits `key: rest`; returns null when the text is not a mapping entry.
function splitKey(text: string, no: number): { key: string; rest: string } | null {
  const c = text[0];
  if (c === '"' || c === "'") {
    const [key, end] = readQuoted(text, 0, no);
    const m = /^\s*:(\s|$)/.exec(text.slice(end));
    if (!m) return null;
    return { key, rest: text.slice(end + m[0].length) };
  }
  if (c === "[" || c === "{") return null;
  const m = /:(\s|$)/.exec(text);
  if (!m) return null;
  const key = text.slice(0, m.index).trimEnd();
  if (/\s#/.test(key) || key.startsWith("#")) return null;
  return { key, rest: text.slice(m.index + 1) };
}

class Parser {
  private readonly lines: string[];
  private pos = 0;
  private depth = 0;

  constructor(text: string) {
    this.lines = text.split(/\r?\n/);
  }

  parse(): YamlValue {
    const first = this.peek();
    if (!first) return null;
    const value = this.blockAt(first, -1);
    const extra = this.peek();
    if (extra) throw new YamlSyntaxError(extra.no, "unexpected content");
    return value;
  }

  private peek(): PeekedLine | null {
    while (this.pos < this.lines.length) {
      const raw = this.lines[this.pos] ?? "";
      const text = raw.trimStart();
      if (text === "" || text.startsWith("#")) {
        this.pos += 1;
        continue;
      }
      const no = this.pos + 1;
      const lead = raw.slice(0, raw.length - text.length);
      if (lead.includes("\t"))
        throw new YamlSyntaxError(no, "tabs are not allowed for indentation");
      if (lead === "" && /^(---|\.\.\.)(\s|$)/.test(text)) {
        throw new YamlSyntaxError(no, "multiple documents are not supported");
      }
      return { indent: lead.length, text: text.trimEnd(), no };
    }
    return null;
  }

  // Child block strictly deeper than `parent`; undefined when there is none.
  private block(parent: number): YamlValue | undefined {
    const l = this.peek();
    if (!l || l.indent <= parent) return undefined;
    return this.blockAt(l, parent);
  }

  private blockAt(l: PeekedLine, parent: number): YamlValue {
    if (this.depth >= MAX_DEPTH) throw tooDeep(l.no);
    this.depth += 1;
    try {
      return this.blockAtInner(l, parent);
    } finally {
      this.depth -= 1;
    }
  }

  private blockAtInner(l: PeekedLine, parent: number): YamlValue {
    if (isSeqItem(l.text)) return this.seq(l.indent);
    if (splitKey(l.text, l.no)) return this.map(l.indent);
    this.pos += 1;
    return this.inline(l.text, parent, l.no);
  }

  private map(indent: number): YamlValue {
    const out: { [key: string]: YamlValue } = {};
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw new YamlSyntaxError(l.no, "bad indentation");
      if (isSeqItem(l.text)) throw new YamlSyntaxError(l.no, "unexpected sequence item in mapping");
      const entry = splitKey(l.text, l.no);
      if (!entry) throw new YamlSyntaxError(l.no, "expected 'key: value'");
      if (Object.prototype.hasOwnProperty.call(out, entry.key)) {
        throw new YamlSyntaxError(l.no, `duplicate key "${entry.key}"`);
      }
      this.pos += 1;
      let value: YamlValue;
      if (COMMENT_OR_EMPTY.test(entry.rest)) {
        const n = this.peek();
        if (n && n.indent === indent && isSeqItem(n.text)) value = this.seq(indent);
        else value = this.block(indent) ?? null;
      } else {
        value = this.inline(entry.rest, indent, l.no);
      }
      setKey(out, entry.key, value);
    }
    return out;
  }

  private seq(indent: number): YamlValue {
    const out: YamlValue[] = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw new YamlSyntaxError(l.no, "bad indentation");
      if (!isSeqItem(l.text)) break;
      const dash = /^-( +|$)/.exec(l.text);
      const width = dash ? dash[0].length : 1;
      const after = l.text.slice(width);
      if (COMMENT_OR_EMPTY.test(after)) {
        this.pos += 1;
        out.push(this.block(indent) ?? null);
      } else if (isSeqItem(after) || splitKey(after, l.no)) {
        // Rewrite the line so the inline content becomes a nested block at its own column.
        this.lines[this.pos] = " ".repeat(indent + width) + after;
        out.push(this.blockAt({ indent: indent + width, text: after, no: l.no }, indent));
      } else {
        this.pos += 1;
        out.push(this.inline(after, indent, l.no));
      }
    }
    return out;
  }

  // Parses the inline remainder of a line. `this.pos` already points past that line.
  private inline(text: string, parent: number, no: number): YamlValue {
    const t = text.trim();
    const c = t[0];
    if (c === "&" || c === "*")
      throw new YamlSyntaxError(no, "anchors and aliases are not supported");
    if (c === "!") throw new YamlSyntaxError(no, "tags are not supported");
    if (c === "@" || c === "`") throw new YamlSyntaxError(no, `reserved indicator "${c}"`);
    if (c === "|" || c === ">") return this.blockScalar(t, parent, no);
    if (c === '"' || c === "'") {
      const [s, end] = readQuoted(t, 0, no);
      if (!COMMENT_OR_EMPTY.test(t.slice(end)))
        throw new YamlSyntaxError(no, "unexpected text after quoted string");
      return s;
    }
    if (c === "[" || c === "{") {
      const [v, end] = flowValue(t, 0, no);
      if (!COMMENT_OR_EMPTY.test(t.slice(end)))
        throw new YamlSyntaxError(no, "unexpected text after flow collection");
      return v;
    }
    const plain = stripComment(t);
    if (/:(\s|$)/.test(plain)) throw new YamlSyntaxError(no, "mapping values are not allowed here");
    return resolvePlain(plain);
  }

  private blockScalar(header: string, parent: number, no: number): string {
    const m = /^([|>])([+-]?)\s*(#.*)?$/.exec(header);
    if (!m) throw new YamlSyntaxError(no, "unsupported block scalar header");
    const folded = m[1] === ">";
    const strip = m[2] === "-";
    if (m[2] === "+") throw new YamlSyntaxError(no, "keep chomping is not supported");
    const body: string[] = [];
    let indent = -1;
    while (this.pos < this.lines.length) {
      const raw = this.lines[this.pos] ?? "";
      if (raw.trim() === "") {
        body.push("");
        this.pos += 1;
        continue;
      }
      const lead = raw.length - raw.trimStart().length;
      if (indent < 0) {
        if (lead <= parent) break;
        indent = lead;
      }
      if (lead < indent) break;
      body.push(raw.slice(indent).trimEnd() === "" ? "" : raw.slice(indent));
      this.pos += 1;
    }
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    if (body.length === 0) return "";
    const text = folded ? foldLines(body) : body.join("\n");
    return strip ? text : `${text}\n`;
  }
}

function foldLines(body: string[]): string {
  let out = "";
  let prev: string | null = null;
  let blanks = 0;
  for (const l of body) {
    if (l === "") {
      blanks += 1;
      continue;
    }
    if (prev === null) {
      out = "\n".repeat(blanks) + l;
    } else {
      const special = /^[ \t]/.test(l) || /^[ \t]/.test(prev);
      const breaks = blanks + (special ? 1 : 0);
      out += (breaks > 0 ? "\n".repeat(breaks) : " ") + l;
    }
    prev = l;
    blanks = 0;
  }
  return out;
}

export function parseYaml(text: string): { value: YamlValue; errors: YamlError[] } {
  try {
    return { value: new Parser(text).parse(), errors: [] };
  } catch (e) {
    if (e instanceof YamlSyntaxError)
      return { value: null, errors: [{ line: e.line, message: e.message }] };
    throw e;
  }
}

// Output ------------------------------------------------------------------

const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
const BLOCK_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f\u0085\u2028\u2029]/;

function needsQuote(s: string): boolean {
  return (
    s === "" ||
    s !== s.trim() ||
    resolvePlain(s) !== s ||
    CONTROL.test(s) ||
    /^[[\]{},#&*!|>'"%@`]/.test(s) ||
    /^[-?:](\s|$)/.test(s) ||
    /:(\s|$)/.test(s) ||
    /\s#/.test(s) ||
    s.startsWith("---") ||
    s.startsWith("...")
  );
}

function canBlock(s: string): boolean {
  if (BLOCK_UNSAFE.test(s) || /^[ \t\n]/.test(s) || s.endsWith("\n\n")) return false;
  const body = s.endsWith("\n") ? s.slice(0, -1) : s;
  return !body.split("\n").some((l) => l !== "" && l.trim() === "");
}

function scalarLines(v: string | number | boolean | null): string[] {
  if (v === null) return ["null"];
  if (typeof v === "boolean") return [v ? "true" : "false"];
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError("cannot stringify a non-finite number");
    return [String(v)];
  }
  if (v.includes("\n")) {
    if (!canBlock(v)) return [JSON.stringify(v)];
    const keep = v.endsWith("\n");
    return [keep ? "|" : "|-", ...(keep ? v.slice(0, -1) : v).split("\n")];
  }
  return [needsQuote(v) ? JSON.stringify(v) : v];
}

function formatKey(k: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(k) ? k : JSON.stringify(k);
}

function indent2(l: string): string {
  return l === "" ? l : `  ${l}`;
}

function isFilled(v: YamlValue): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return v !== null && typeof v === "object" && Object.keys(v).length > 0;
}

function blockLines(v: YamlValue, ancestors: Set<object> = new Set()): string[] {
  if (v === undefined) throw new TypeError("cannot stringify an undefined value");
  if (v !== null && typeof v === "object") {
    if (ancestors.has(v)) throw new TypeError("cannot stringify a circular structure");
    ancestors.add(v);
    try {
      return containerLines(v, ancestors);
    } finally {
      ancestors.delete(v);
    }
  }
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean" && v !== null) {
    throw new TypeError(`cannot stringify a value of type ${typeof v}`);
  }
  return scalarLines(v);
}

function containerLines(
  v: YamlValue[] | { [key: string]: YamlValue },
  ancestors: Set<object>,
): string[] {
  if (Array.isArray(v)) {
    if (v.length === 0) return ["[]"];
    const out: string[] = [];
    for (const item of v) {
      const ls = blockLines(item, ancestors);
      out.push(`- ${ls[0] ?? ""}`, ...ls.slice(1).map(indent2));
    }
    return out;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return ["{}"];
  const out: string[] = [];
  for (const k of keys) {
    const val = v[k] as YamlValue;
    const ls = blockLines(val, ancestors);
    if (isFilled(val)) out.push(`${formatKey(k)}:`, ...ls.map(indent2));
    else out.push(`${formatKey(k)}: ${ls[0] ?? ""}`, ...ls.slice(1).map(indent2));
  }
  return out;
}

export function stringifyYaml(value: YamlValue): string {
  return `${blockLines(value).join("\n")}\n`;
}
