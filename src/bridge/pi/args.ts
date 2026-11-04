/**
 * `ama --mode acp --bridge pi [--lang zh|en] [-- <pi 的参数>]` 的参数解析（#254）。
 *
 * - `--bridge` 只认 `pi`，且必须配 `--mode acp`；除 `--lang` 外不收别的选项（桥不起 ama 的模型与会话）；
 * - `--` 之后的参数原样交给 pi（宿主的 `--skill`、`--append-system-prompt` 注入照用），但桥自己管的旗标
 *   一律拒绝：模式、会话选择与存储、`--tools`、`--no-mcp`、`-p`——放行它们会让审批闸、会话 id 或 MCP 透传失效。
 */

import { UsageError } from "../../cli/args.js";
import { LOCALES, msg, type Locale } from "../../i18n/index.js";

export interface BridgeArgs {
  bridge: "pi";
  passthrough: string[];
  lang?: Locale;
}

/** 桥自己管的 pi 旗标（长名与短名；`--名=值` 形式同样命中）。 */
const OWNED_FLAGS: ReadonlySet<string> = new Set([
  "--mode",
  "--session",
  "--session-id",
  "--session-dir",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--fork",
  "--no-session",
  "--tools",
  "-t",
  "--no-mcp",
  "--print",
  "-p",
]);

/** `--` 之前出现 `--bridge`（含 `--bridge=pi`）。 */
export function hasBridgeFlag(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === "--") return false;
    if (token === "--bridge" || token.startsWith("--bridge=")) return true;
  }
  return false;
}

/** 宽松预扫 `--lang`（`--` 之前，无效值忽略）：用法错误信息也要按界面语言出。 */
export function bridgeLangOf(argv: readonly string[]): Locale | undefined {
  let lang: Locale | undefined;
  for (let i = 0; i < argv.length && argv[i] !== "--"; i++) {
    const token = argv[i] ?? "";
    const value =
      token === "--lang" ? argv[i + 1] : token.startsWith("--lang=") ? token.slice(7) : undefined;
    if (value !== undefined && (LOCALES as readonly string[]).includes(value))
      lang = value as Locale;
  }
  return lang;
}

/** 解析；用法错误抛 {@link UsageError}（退出码 2）。 */
export function parseBridgeArgs(argv: readonly string[]): BridgeArgs {
  const m = msg().bridge.args;
  let bridge: string | undefined;
  let mode: string | undefined;
  let lang: Locale | undefined;
  let passthrough: string[] = [];
  const valueOf = (name: string, inline: string | undefined, at: number): [string, number] => {
    if (inline !== undefined) return [inline, at];
    const next = argv[at + 1];
    if (next === undefined) throw new UsageError(m.needsValue(name));
    return [next, at + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--") {
      passthrough = argv.slice(i + 1).map(String);
      break;
    }
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;
    const inline = token.startsWith("--") && eq !== -1 ? token.slice(eq + 1) : undefined;
    if (name !== "--bridge" && name !== "--mode" && name !== "--lang")
      throw new UsageError(m.unknownOption(token));
    const [value, next] = valueOf(name, inline, i);
    i = next;
    if (name === "--bridge") bridge = value;
    else if (name === "--mode") mode = value;
    else if ((LOCALES as readonly string[]).includes(value)) lang = value as Locale;
    else throw new UsageError(m.unknownOption(`--lang ${value}`));
  }
  if (bridge !== "pi") throw new UsageError(m.unsupportedBridge(bridge ?? ""));
  if (mode !== "acp") throw new UsageError(m.needsAcpMode);
  for (const token of passthrough) {
    const flag = token.startsWith("--") ? token.split("=")[0]! : token;
    if (OWNED_FLAGS.has(flag)) throw new UsageError(m.ownedFlag(flag));
  }
  return { bridge: "pi", passthrough, ...(lang !== undefined ? { lang } : {}) };
}
