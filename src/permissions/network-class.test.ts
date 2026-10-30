/**
 * 权限类 `network`（web_fetch）：六种模式真值表、`web_fetch(<glob>)` 规则、按主机的会话记忆、
 * auto 规则层对本机 / 私网 URL 的拒绝、分类器输入。
 */

import { describe, expect, it } from "vitest";
import { buildClassifierPrompt, CLASSIFIER_SYSTEM_PROMPT } from "./classifier.js";
import { networkBlockReason, networkGrantHost, networkRuleMatches } from "./network-class.js";
import { PermissionPipeline, sessionGrantFor } from "./pipeline.js";
import { parseRule } from "./rules.js";
import type { PermissionMode, PermissionVerdict } from "./types.js";

const cwd = "/work";

function pipeline(mode: PermissionMode, allow: string[] = [], deny: string[] = []) {
  return new PermissionPipeline({
    mode,
    cwd,
    rules: [
      ...deny.map((r) => parseRule(r, "deny", "user")),
      ...allow.map((r) => parseRule(r, "allow", "user")),
    ],
  });
}

function fetchCall(url: string, unattended = false) {
  return { toolName: "web_fetch", permission: "network" as const, input: { url }, unattended };
}

const DOC = "https://docs.example.com/guide/intro?x=1";

describe("network 权限类：模式真值表", () => {
  const modes: PermissionMode[] = [
    "plan",
    "allowlist",
    "default",
    "auto-edit",
    "auto",
    "full-auto",
  ];

  it("有人值守：plan 询问、allowlist 拒绝、default / auto-edit 询问、auto 交分类器、full-auto 放行", () => {
    const verdicts = modes.map((m) => pipeline(m).check(fetchCall(DOC)));
    expect(verdicts.map((v) => v.decision)).toEqual(["ask", "deny", "ask", "ask", "ask", "allow"]);
    expect(verdicts[4]).toMatchObject({ step: "auto-classify", classify: true });
    expect(verdicts[0]).toMatchObject({ step: "mode", approvalReason: "mode" });
  });

  it("无人值守（-p）：凡是询问都变拒绝，只有 full-auto 放行", () => {
    const decisions = modes.map((m) => pipeline(m).check(fetchCall(DOC, true)).decision);
    expect(decisions).toEqual(["deny", "deny", "deny", "deny", "deny", "allow"]);
  });

  it("--allow 'web_fetch(example.com)'：-p 下 default / plan / allowlist / auto 都放行", () => {
    for (const mode of ["default", "plan", "allowlist", "auto"] as const) {
      const v = pipeline(mode, ["web_fetch(example.com)"]).check(fetchCall(DOC, true));
      expect(v.decision, mode).toBe("allow");
      expect(v.step, mode).toBe("allow-rule");
    }
    expect(
      pipeline("default", ["web_fetch(example.com)"]).check(fetchCall("https://evil.org/", true))
        .decision,
    ).toBe("deny");
  });

  it("deny 规则在 full-auto 下也生效，且优先于 allow", () => {
    const p = pipeline("full-auto", ["web_fetch"], ["web_fetch(*.example.com)"]);
    expect(p.check(fetchCall(DOC)).decision).toBe("deny");
    expect(p.check(fetchCall("https://example.org/")).decision).toBe("allow");
  });

  it("Hook ask 照常询问，Hook allow 放行", () => {
    const p = pipeline("default");
    expect(p.check({ ...fetchCall(DOC), hookDecision: "ask" }).step).toBe("hook");
    expect(p.check({ ...fetchCall(DOC), hookDecision: "allow" }).decision).toBe("allow");
  });
});

describe("auto 规则层：URL 静态校验", () => {
  const blocked = [
    "http://127.0.0.1:8080/",
    "http://localhost/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://10.1.2.3/",
    "file:///etc/passwd",
    "https://user:pass@example.com/",
    "http://intranet/",
  ];
  for (const url of blocked) {
    it(`${url} → deny（规则层），连会话记忆与 allow 规则也不放行`, () => {
      const p = pipeline("auto", ["web_fetch"]);
      p.rememberForSession("web_fetch", { url });
      const v: PermissionVerdict = p.check(fetchCall(url));
      expect(v.decision).toBe("deny");
      expect(v.step).toBe("auto-rule");
      expect(v.auto).toMatchObject({ layer: "rule", decision: "deny" });
    });
  }

  it("公网 URL 不被规则层拦", () => {
    expect(networkBlockReason({ url: DOC })).toBeUndefined();
    expect(networkBlockReason({})).toBe("url is missing");
  });
});

describe("web_fetch(<pattern>) 规则", () => {
  const hit = (pattern: string, url: string) => networkRuleMatches(pattern, { url });

  it("裸域名命中自己与子域，不命中同后缀的别家", () => {
    expect(hit("example.com", "https://example.com/")).toBe(true);
    expect(hit("example.com", "https://docs.example.com/a/b")).toBe(true);
    expect(hit("example.com", "https://notexample.com/")).toBe(false);
    expect(hit("example.com", "https://example.com.evil.org/")).toBe(false);
    expect(hit("EXAMPLE.com", "https://Docs.Example.COM/")).toBe(true);
    expect(hit("https://example.com", "http://example.com:8080/x")).toBe(true);
  });

  it("主机 glob：* 不跨 /；路径 glob：* 不跨 /，** 跨", () => {
    expect(hit("*.example.com", "https://docs.example.com/x")).toBe(true);
    expect(hit("*.example.com", "https://example.com/x")).toBe(false);
    expect(hit("docs.example.com/api/*", "https://docs.example.com/api/v1")).toBe(true);
    expect(hit("docs.example.com/api/*", "https://docs.example.com/api/v1/x")).toBe(false);
    expect(hit("docs.example.com/api/**", "https://docs.example.com/api/v1/x")).toBe(true);
    expect(hit("docs.example.com/api/**", "https://www.example.com/api/v1")).toBe(false);
    expect(hit("*", "https://anything.org/")).toBe(true);
  });

  it("查询串与端口不参与匹配；非 http(s) 或缺 url 不命中", () => {
    expect(hit("docs.example.com/guide/intro", DOC)).toBe(true);
    expect(hit("example.com", "ftp://example.com/")).toBe(false);
    expect(networkRuleMatches("example.com", { path: "/x" })).toBe(false);
  });
});

describe("allow_session：按主机记住", () => {
  it("同主机（不分大小写、不分路径与端口）不再询问，别的主机仍询问", () => {
    const p = pipeline("default");
    expect(sessionGrantFor("web_fetch", { url: DOC }, cwd)).toEqual({
      toolName: "web_fetch",
      kind: "host",
      prefix: "docs.example.com",
    });
    p.rememberForSession("web_fetch", { url: DOC });
    expect(p.check(fetchCall("https://DOCS.example.com/other")).step).toBe("session");
    expect(p.check(fetchCall("https://example.com/")).decision).toBe("ask");
    expect(p.check(fetchCall("https://evil.docs.example.com.org/")).decision).toBe("ask");
    expect(networkGrantHost({ url: "not a url" })).toBeUndefined();
  });

  it("会话记忆不越过 deny 规则", () => {
    const p = pipeline("default", [], ["web_fetch(docs.example.com)"]);
    p.rememberForSession("web_fetch", { url: DOC });
    expect(p.check(fetchCall(DOC)).decision).toBe("deny");
  });
});

describe("分类器", () => {
  it("系统提示说明公开文档 / 包注册表页是常规，带密钥样查询串的要询问", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(
      /web_fetch of a public documentation or package-registry page/,
    );
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(
      /query string looks like a key or a long random token/,
    );
  });

  it("参数原样进数据块（URL 可见）", () => {
    const prompt = buildClassifierPrompt({
      toolName: "web_fetch",
      input: { url: DOC },
      cwd,
      projectRoot: cwd,
    });
    expect(prompt).toContain('"url":"https://docs.example.com/guide/intro?x=1"');
  });
});
