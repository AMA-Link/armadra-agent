/**
 * web_fetch 地址守卫：URL 形状、私网 / 元数据地址（IPv4、IPv6、IPv4 映射 / NAT64 / 6to4）、
 * DNS 多地址有一个私网即拒、钉住的 lookup、重定向策略。不出网（lookup 全部注入）。
 */

import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_LENGTH,
  MAX_URL_LENGTH,
  blockedAddressReason,
  checkFetchUrl,
  embeddedIPv4,
  ipv6Groups,
  pinnedLookup,
  redirectPolicy,
  resolvePublicAddresses,
} from "./url-guard.js";

const lookupOf =
  (...addresses: string[]) =>
  async (): Promise<LookupAddress[]> =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("checkFetchUrl", () => {
  it("公网 http(s) URL 通过，主机名小写、去末尾点", () => {
    const ok = checkFetchUrl("  https://Docs.Example.com./a?b=1 ");
    expect(ok).toMatchObject({ ok: true, hostname: "docs.example.com" });
    expect(checkFetchUrl("http://93.184.216.34/")).toMatchObject({ ok: true });
  });

  const rejected: [string, RegExp][] = [
    ["", /empty/],
    ["example.com/x", /valid absolute URL/],
    ["ftp://example.com/", /only http and https/],
    ["file:///etc/passwd", /only http and https/],
    ["javascript:alert(1)", /only http and https/],
    ["https://user@example.com/", /credentials/],
    ["https://u:p@example.com/", /credentials/],
    ["http://localhost:3000/", /local host name/],
    ["http://LOCALHOST./", /local host name/],
    ["http://api.localhost/", /local host name/],
    ["http://intranet/", /local host name/],
    ["http://127.0.0.1/", /private, loopback/],
    ["http://2130706433/", /private, loopback/],
    ["http://0x7f.1/", /private, loopback/],
    ["http://0.0.0.0/", /private, loopback/],
    ["http://10.0.0.1/", /private/],
    ["http://172.16.5.4/", /private/],
    ["http://172.31.255.255/", /private/],
    ["http://192.168.1.1/", /private/],
    ["http://100.64.0.1/", /private/],
    ["http://169.254.169.254/latest/meta-data/", /cloud metadata/],
    ["http://100.100.100.200/", /cloud metadata/],
    ["http://224.0.0.1/", /reserved/],
    ["http://255.255.255.255/", /reserved/],
    ["http://[::1]/", /loopback/],
    ["http://[::ffff:127.0.0.1]/", /embeds 127\.0\.0\.1/],
    ["http://[::ffff:a9fe:a9fe]/", /embeds 169\.254\.169\.254/],
    ["http://[fd00:ec2::254]/", /cloud metadata/],
    ["http://[fc00::1]/", /private/],
    ["http://[fe80::1]/", /link-local/],
    ["http://[ff02::1]/", /multicast/],
  ];
  for (const [url, reason] of rejected) {
    it(`拒绝 ${url || "（空）"}`, () => {
      const r = checkFetchUrl(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(reason);
    });
  }

  it("长度上限：URL ≤ 2048、查询串 ≤ 1024", () => {
    const base = "https://example.com/?q=";
    expect(checkFetchUrl(base + "a".repeat(MAX_QUERY_LENGTH - 2)).ok).toBe(true);
    expect(checkFetchUrl(base + "a".repeat(MAX_QUERY_LENGTH))).toMatchObject({ ok: false });
    expect(checkFetchUrl(`https://example.com/${"p".repeat(MAX_URL_LENGTH)}`)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/longer than 2048/),
    });
  });

  it("172.15 / 172.32 / 100.63 / 11.0.0.1 这些边界外的公网地址通过", () => {
    for (const ip of ["172.15.255.255", "172.32.0.1", "100.63.255.255", "11.0.0.1", "8.8.8.8"])
      expect(checkFetchUrl(`http://${ip}/`).ok, ip).toBe(true);
    expect(checkFetchUrl("http://[2606:4700::1111]/").ok).toBe(true);
  });
});

describe("IPv6 解析与嵌入的 IPv4", () => {
  it("ipv6Groups 展开 ::、点分尾部；不合法返回 undefined", () => {
    expect(ipv6Groups("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(ipv6Groups("fe80::1%en0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups("1::2::3")).toBeUndefined();
    expect(ipv6Groups("1:2:3")).toBeUndefined();
    expect(ipv6Groups("::ffff:1.2.3.999")).toBeUndefined();
  });

  it("映射 / 兼容 / NAT64 / 6to4 里嵌的 IPv4 按 IPv4 判", () => {
    expect(embeddedIPv4("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(embeddedIPv4("::10.0.0.1")).toBe("10.0.0.1");
    expect(embeddedIPv4("64:ff9b::a9fe:a9fe")).toBe("169.254.169.254");
    expect(embeddedIPv4("2002:c0a8:0101::1")).toBe("192.168.1.1");
    expect(embeddedIPv4("2606:4700::1111")).toBeUndefined();
    expect(embeddedIPv4("::1")).toBeUndefined();
    expect(embeddedIPv4("::")).toBeUndefined();
    expect(blockedAddressReason("::1")).toBe(
      "::1 is a private, loopback, link-local or multicast address",
    );
    expect(blockedAddressReason("::")).toMatch(/private, loopback/);
    expect(blockedAddressReason("::0.1.2.3")).toMatch(/private, loopback/);
    expect(blockedAddressReason("169.254.1.1")).toMatch(/private, loopback, link-local/);
    expect(blockedAddressReason("fe80::1%en0")).toMatch(/link-local/);
    expect(blockedAddressReason("64:ff9b::a00:1")).toMatch(/embeds 10\.0\.0\.1/);
    expect(blockedAddressReason("2002:c0a8:0101::1")).toMatch(/embeds 192\.168\.1\.1/);
    expect(blockedAddressReason("64:ff9b::808:808")).toBeUndefined();
    expect(blockedAddressReason("not-an-ip")).toMatch(/not an IP/);
  });
});

describe("resolvePublicAddresses", () => {
  it("全部公网地址 → 通过并返回地址", async () => {
    const r = await resolvePublicAddresses(
      "docs.example.com",
      lookupOf("93.184.216.34", "2606:4700::1"),
    );
    expect(r).toMatchObject({ ok: true, addresses: [{ address: "93.184.216.34" }, { family: 6 }] });
  });

  it("多地址里夹一个私网 / 元数据地址 → 拒绝", async () => {
    for (const bad of ["10.0.0.5", "169.254.169.254", "::1", "::ffff:192.168.0.1", "fd12::1"]) {
      const r = await resolvePublicAddresses("rebind.example.com", lookupOf("93.184.216.34", bad));
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/^rebind\.example\.com resolves to /);
    }
  });

  it("解析失败与空结果给出原因；IP 字面量不查 DNS", async () => {
    const failing = async (): Promise<LookupAddress[]> => {
      throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
    };
    expect(await resolvePublicAddresses("x.example", failing)).toEqual({
      ok: false,
      reason: "cannot resolve x.example (ENOTFOUND)",
    });
    expect(await resolvePublicAddresses("x.example", lookupOf())).toMatchObject({ ok: false });
    const never = async (): Promise<LookupAddress[]> => {
      throw new Error("must not be called");
    };
    expect(await resolvePublicAddresses("8.8.8.8", never)).toMatchObject({ ok: true });
    expect(await resolvePublicAddresses("10.0.0.1", never)).toMatchObject({ ok: false });
  });
});

describe("pinnedLookup", () => {
  const addresses = [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:4700::1", family: 6 },
  ];

  it("all: true 返回全部已检查地址；否则返回第一个", () => {
    const lookup = pinnedLookup(addresses);
    const seen: unknown[] = [];
    lookup("evil.example.com", { all: true }, (err, address) => seen.push(err, address));
    lookup("evil.example.com", {}, (err, address, family) => seen.push(err, address, family));
    lookup("evil.example.com", ((err: unknown, address: unknown) =>
      seen.push(err, address)) as never);
    expect(seen).toEqual([null, addresses, null, "93.184.216.34", 4, null, "93.184.216.34"]);
  });
});

describe("redirectPolicy", () => {
  const u = (s: string) => new URL(s);
  it("同主机同端口跟随；http → https 升级跟随", () => {
    expect(redirectPolicy(u("https://a.example.com/x"), u("https://a.example.com/y"))).toBe(
      "follow",
    );
    expect(redirectPolicy(u("http://a.example.com/x"), u("https://A.example.com/x"))).toBe(
      "follow",
    );
  });
  it("跨主机、子域、换端口、https → http 降级都不跟", () => {
    expect(redirectPolicy(u("https://a.example.com/"), u("https://b.example.com/"))).toBe(
      "cross-host",
    );
    expect(redirectPolicy(u("https://example.com/"), u("https://www.example.com/"))).toBe(
      "cross-host",
    );
    expect(redirectPolicy(u("https://a.example.com/"), u("https://a.example.com:8443/"))).toBe(
      "cross-host",
    );
    expect(redirectPolicy(u("https://a.example.com/"), u("http://a.example.com/"))).toBe(
      "cross-host",
    );
  });
});
