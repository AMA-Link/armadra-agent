/**
 * HTML → Markdown：典型页面的黄金输出（文档站、包注册表页、博客、表格、代码块、无 main 的页面），
 * 以及实体、链接、丢弃的元素与编码嗅探。
 */

import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToMarkdown, sniffMetaCharset } from "./html-to-markdown.js";

const DOCS_SITE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Install &mdash; Widget Docs</title>
<style>body{color:red}</style><script>window.x = "<main>not this</main>";</script></head>
<body>
<header><a href="/">Widget</a></header>
<nav><ul><li><a href="/a">Nav A</a><li><a href="/b">Nav B</a></ul></nav>
<main>
  <h1>Install</h1>
  <p>Run <code>npm i widget</code>, then read the
     <a href="../api/#setup">API&nbsp;reference</a>.</p>
  <h2 id="req">Requirements</h2>
  <ul>
    <li>Node <strong>22</strong> or newer
    <li>One of:
      <ul><li>macOS</li><li>Linux</li></ul>
    <li><a href="javascript:void(0)">Do nothing</a>
  </ul>
  <pre><code class="language-sh">npm i widget
widget --version &gt; out.txt</code></pre>
  <blockquote><p>Note: <em>beta</em> builds may break.</p></blockquote>
</main>
<footer>&copy; 2026 Widget</footer>
</body></html>`;

const REGISTRY = `<html><head><title>left-pad - npm</title></head><body>
<div id="top"><form><input name="q"><button>Search</button></form></div>
<div role="main">
<h1>left-pad <span>1.3.0</span></h1>
<p>String left pad</p>
<table>
  <thead><tr><th>Version</th><th>Published</th></tr></thead>
  <tbody><tr><td>1.3.0</td><td>2018-04-09</td></tr><tr><td>1.2.0<td>2017-11-30</tr></tbody>
</table>
<h3>Install</h3><pre>npm i left-pad</pre>
<img src="/badge.svg" alt="downloads: 2M/week"><img src="/spacer.gif">
</div>
<aside>Sponsored</aside>
</body></html>`;

const BLOG = `<html><head><title>Why we rewrote it</title><base href="https://blog.example.org/posts/"></head>
<body><article>
<h1>Why we rewrote it</h1>
<p>We had <b>three</b> problems:<br>speed,<br>size, and <i>&ldquo;taste&rdquo;</i>.</p>
<ol start="2"><li><p>First</p></li><li>Second &amp; last</li></ol>
<p>See <a href="next.html">the next post</a> or <a href="#top">top</a>.</p>
<hr>
<p>Comments <!-- hidden <b>comment</b> --> are closed.</p>
<svg><text>chart</text></svg><noscript>Enable JS</noscript>
</article></body></html>`;

const NO_MAIN = `<p>Plain fragment with <a href="https://x.example.com/a b">a link</a>
and a | pipe.
<p>Second paragraph &#169; &#x1F600; &unknown; &amp`;

const PRE_WITH_FENCE =
  '<main><pre class="lang-md">Use ```js fences```\n  keep  spacing</pre></main>';

describe("htmlToMarkdown：黄金输出", () => {
  it("文档站：取 main，丢 nav / header / footer / script / style，嵌套列表、代码块、引用", () => {
    const r = htmlToMarkdown(DOCS_SITE, "https://docs.widget.dev/guide/install");
    expect(r.title).toBe("Install — Widget Docs");
    expect(r.markdown).toBe(
      [
        "# Install",
        "",
        "Run `npm i widget`, then read the [API reference](https://docs.widget.dev/api/#setup).",
        "",
        "## Requirements",
        "",
        "- Node **22** or newer",
        "- One of:",
        "  - macOS",
        "  - Linux",
        "- Do nothing",
        "",
        "```sh",
        "npm i widget",
        "widget --version > out.txt",
        "```",
        "",
        "> Note: *beta* builds may break.",
      ].join("\n"),
    );
  });

  it("包注册表页：role=main、表格、无 code 的 pre、图片只留 alt", () => {
    const r = htmlToMarkdown(REGISTRY, "https://registry.example.com/package/left-pad");
    expect(r.title).toBe("left-pad - npm");
    expect(r.markdown).toBe(
      [
        "# left-pad 1.3.0",
        "",
        "String left pad",
        "",
        "| Version | Published |",
        "| --- | --- |",
        "| 1.3.0 | 2018-04-09 |",
        "| 1.2.0 | 2017-11-30 |",
        "",
        "### Install",
        "",
        "```",
        "npm i left-pad",
        "```",
        "",
        "downloads: 2M/week",
      ].join("\n"),
    );
    expect(r.markdown).not.toContain("Sponsored");
    expect(r.markdown).not.toContain("Search");
  });

  it("博客：article、<base> 解析相对链接、换行、有序列表起始号、注释与 svg / noscript 丢弃", () => {
    const r = htmlToMarkdown(BLOG, "https://blog.example.org/posts/why.html");
    expect(r.markdown).toBe(
      [
        "# Why we rewrote it",
        "",
        "We had **three** problems:",
        "speed,",
        "size, and *“taste”*.",
        "",
        "2. First",
        "3. Second & last",
        "",
        "See [the next post](https://blog.example.org/posts/next.html) or top.",
        "",
        "---",
        "",
        "Comments are closed.",
      ].join("\n"),
    );
  });

  it("无 main / body 的片段：整体渲染，标题缺省；链接里的空格编码；实体", () => {
    const r = htmlToMarkdown(NO_MAIN, "https://x.example.com/");
    expect(r.title).toBeUndefined();
    expect(r.markdown).toBe(
      [
        "Plain fragment with [a link](https://x.example.com/a%20b) and a | pipe.",
        "",
        "Second paragraph © 😀 &unknown; &",
      ].join("\n"),
    );
  });

  it("表格单元里的 | 转义；无表头时补空表头行", () => {
    const r = htmlToMarkdown("<table><tr><td>a|b</td><td>c</td></tr></table>");
    expect(r.markdown).toBe(["|  |  |", "| --- | --- |", "| a\\|b | c |"].join("\n"));
  });

  it("pre 里含 ``` 时改用 ~~~~ 围栏，保留原样空白，lang-xxx 作语言", () => {
    expect(htmlToMarkdown(PRE_WITH_FENCE).markdown).toBe(
      ["~~~~md", "Use ```js fences```", "  keep  spacing", "~~~~"].join("\n"),
    );
  });

  it("没有 <title> 时取第一个 h1 作标题", () => {
    expect(htmlToMarkdown("<body><h1>Only <em>heading</em></h1><p>x</p></body>").title).toBe(
      "Only heading",
    );
  });

  it("未闭合标签与畸形输入不抛错", () => {
    expect(() => htmlToMarkdown("<div><p>a<b>b<i>c</div></span><")).not.toThrow();
    expect(htmlToMarkdown("<div><p>a<b>b</div>").markdown).toBe("a**b**");
    expect(htmlToMarkdown("x < y and <3").markdown).toBe("x < y and <3");
  });
});

describe("工具函数", () => {
  it("decodeEntities：命名、十进制、十六进制、非法码位", () => {
    expect(decodeEntities("&lt;a&gt; &quot;q&quot; &#39;s&#39; &#x41; &#0; &bogus;")).toBe(
      "<a> \"q\" 's' A � &bogus;",
    );
  });

  it("sniffMetaCharset：meta charset 与 http-equiv", () => {
    expect(sniffMetaCharset('<meta charset="GBK">')).toBe("gbk");
    expect(
      sniffMetaCharset('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">'),
    ).toBe("shift_jis");
    expect(sniffMetaCharset("<p>no meta</p>")).toBeUndefined();
  });
});
