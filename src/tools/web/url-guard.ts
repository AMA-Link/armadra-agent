/**
 * `web_fetch` 的地址守卫（docs/guides/permissions.md「网络类」）：URL 校验、私网 / 元数据地址判定、
 * DNS 钉住与重定向策略。纯 `node:*`，模型侧固定英文。
 *
 * - URL：只收 `http:` / `https:`；拒 userinfo；全文 ≤ 2 048 字符、查询串 ≤ 1 024 字符；主机名必须含 `.`
 *   （`localhost`、`*.localhost` 与无点主机一律拒——本机服务请走 bash 审批）；IP 字面量当场判定。
 * - 地址：解析出的**全部**地址都不得落在环回、未指定、链路本地（含云元数据 `169.254.169.254`）、
 *   RFC 1918、运营商 NAT `100.64/10`、基准测试 `198.18/15`、保留与广播、组播、IPv6 ULA `fc00::/7`、
 *   站点本地 `fec0::/10`、链路本地 `fe80::/10`、组播 `ff00::/8`、未指定与已弃用的兼容段 `::/96`；IPv4 映射 / 兼容、NAT64 `64:ff9b::/96`、
 *   6to4 `2002::/16` 里嵌的 IPv4 按 IPv4 再判一次。有一个落在里面就拒（防「多地址里夹一个内网」）。
 * - DNS 钉住：连接用 `pinnedLookup()` 只返回已检查过的地址，防检查与连接之间被重新解析（DNS 重绑定）。
 * - 重定向：同主机（主机名与端口相同、不从 https 降到 http）由调用方跟随并逐跳重检；跨主机不跟。
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

export const MAX_URL_LENGTH = 2048;
export const MAX_QUERY_LENGTH = 1024;
export const MAX_SAME_HOST_REDIRECTS = 5;

const V4_BLOCKED: readonly [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const V6_BLOCKED: readonly [string, number][] = [
  ["::", 96],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];
/** 常见云元数据地址：错误说明里单独点名。 */
const METADATA = new Set(["169.254.169.254", "100.100.100.200", "fd00:ec2::254"]);

const blocked = new BlockList();
for (const [net, prefix] of V4_BLOCKED) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of V6_BLOCKED) blocked.addSubnet(net, prefix, "ipv6");

/** IPv6 文本 → 8 个 16 位组；不合法返回 undefined。支持 `::` 与末尾点分 IPv4。 */
export function ipv6Groups(address: string): number[] | undefined {
  let text = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4 !== null) {
    const parts = (v4[1] as string).split(".").map(Number);
    if (parts.some((p) => p > 255)) return undefined;
    const [a, b, c, d] = parts as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] =>
    part === ""
      ? []
      : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  const head = parse(halves[0] as string);
  const tail = halves.length === 2 ? parse(halves[1] as string) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return undefined;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return groups.some((g) => Number.isNaN(g)) ? undefined : groups;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** IPv6 里嵌的 IPv4（映射 / 兼容 / NAT64 / 6to4）；没有返回 undefined。 */
export function embeddedIPv4(address: string): string | undefined {
  const g = ipv6Groups(address);
  if (g === undefined) return undefined;
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);
  // 映射 ::ffff:a.b.c.d；兼容 ::a.b.c.d 只认首段非 0 的（`::`、`::1` 留给 IPv6 段表）
  if (zeros(0, 5) && (g[5] === 0xffff || (g[5] === 0 && (g[6] as number) >= 0x100)))
    return v4FromGroups(g[6] as number, g[7] as number);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6))
    return v4FromGroups(g[6] as number, g[7] as number);
  if (g[0] === 0x2002) return v4FromGroups(g[1] as number, g[2] as number);
  return undefined;
}

/**
 * 地址是否落在禁止段；落在里面返回英文原因（进工具结果），否则 undefined。
 * 不是 IP 文本的一律按禁止（调用方只该传解析结果）。
 */
export function blockedAddressReason(address: string): string | undefined {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 0) return `${address} is not an IP address`;
  const lower = bare.toLowerCase();
  if (METADATA.has(lower)) return `${bare} is a cloud metadata address`;
  if (family === 4) {
    if (bare === "255.255.255.255" || blocked.check(bare, "ipv4"))
      return `${bare} is a private, loopback, link-local or reserved address`;
    return undefined;
  }
  const inner = embeddedIPv4(lower);
  if (inner !== undefined) {
    const reason = blockedAddressReason(inner);
    if (reason !== undefined) return `${bare} embeds ${inner}: ${reason}`;
  }
  if (blocked.check(lower, "ipv6"))
    return `${bare} is a private, loopback, link-local or multicast address`;
  return undefined;
}

export type UrlCheck = { ok: true; url: URL; hostname: string } | { ok: false; reason: string };

/** 主机名：去方括号与末尾点，小写。 */
export function bareHostname(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

/** 静态校验（不查 DNS）：协议、userinfo、长度、主机名形状、IP 字面量。 */
export function checkFetchUrl(raw: string): UrlCheck {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "url is empty" };
  const text = raw.trim();
  if (text.length > MAX_URL_LENGTH)
    return { ok: false, reason: `URL is longer than ${MAX_URL_LENGTH} characters` };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "not a valid absolute URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, reason: `only http and https URLs are supported (got ${url.protocol})` };
  if (url.username !== "" || url.password !== "")
    return { ok: false, reason: "URLs with credentials (user:pass@) are not allowed" };
  if (url.search.length > MAX_QUERY_LENGTH + 1)
    return { ok: false, reason: `query string is longer than ${MAX_QUERY_LENGTH} characters` };
  const hostname = bareHostname(url);
  if (isIP(hostname) !== 0) {
    const reason = blockedAddressReason(hostname);
    return reason === undefined ? { ok: true, url, hostname } : { ok: false, reason };
  }
  if (!hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost"))
    return {
      ok: false,
      reason: `${hostname} is a local host name; web_fetch only reaches public hosts`,
    };
  return { ok: true, url, hostname };
}

export type LookupAll = (hostname: string) => Promise<LookupAddress[]>;

/** 缺省解析：系统解析器，返回全部地址。 */
export const systemLookup: LookupAll = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });

export type ResolveCheck = { ok: true; addresses: LookupAddress[] } | { ok: false; reason: string };

/** 解析主机名并检查全部地址；IP 字面量直接返回。 */
export async function resolvePublicAddresses(
  hostname: string,
  lookup: LookupAll = systemLookup,
): Promise<ResolveCheck> {
  const family = isIP(hostname);
  if (family !== 0) {
    const reason = blockedAddressReason(hostname);
    return reason === undefined
      ? { ok: true, addresses: [{ address: hostname, family }] }
      : { ok: false, reason };
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, reason: `cannot resolve ${hostname}${code ? ` (${code})` : ""}` };
  }
  if (addresses.length === 0) return { ok: false, reason: `cannot resolve ${hostname}` };
  for (const { address } of addresses) {
    const reason = blockedAddressReason(address);
    if (reason !== undefined) return { ok: false, reason: `${hostname} resolves to ${reason}` };
  }
  return { ok: true, addresses };
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** `http.request({ lookup })` 用：只返回已检查过的地址（兼容 `all: true` 与单地址两种调用）。 */
export function pinnedLookup(addresses: readonly LookupAddress[]) {
  return (_hostname: string, options: unknown, callback?: LookupCallback): void => {
    const cb = (typeof options === "function" ? options : callback) as LookupCallback;
    const all =
      typeof options === "object" && options !== null && (options as { all?: boolean }).all;
    const first = addresses[0] as LookupAddress;
    if (all === true) cb(null, [...addresses]);
    else cb(null, first.address, first.family);
  };
}

/**
 * 重定向能否自动跟：同主机名，且同协议同端口或 http → https 升级。其余（跨主机、换端口、
 * https 降到 http）不跟：交给模型再调一次 web_fetch，下一次调用重新过权限。
 */
export function redirectPolicy(from: URL, to: URL): "follow" | "cross-host" {
  if (bareHostname(from) !== bareHostname(to)) return "cross-host";
  if (from.protocol === "http:" && to.protocol === "https:") return "follow";
  return from.protocol === to.protocol && portOf(from) === portOf(to) ? "follow" : "cross-host";
}

function portOf(url: URL): string {
  return url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
}
