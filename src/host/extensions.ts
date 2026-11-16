/**
 * 本地扩展（#301，docs/guides/extensions.md）：用户自己安装、可以有多个的宿主适配器。
 *
 * - 发现：`<configDir>/extensions/` 下的 `*.{mjs,cjs}` 与带 `index.{mjs,cjs}` 的子目录（#305）按入口名排序，
 *   其后是 profile `extensions`（绝对路径，可以是目录）；
 *   不加载项目级。
 * - 激活：每个模块一个独立的 {@link HostApiBinding}，共享工具注册表、事件总线、broker 槽、资源注册表与
 *   保温处理器（共享状态见 api-impl 的 `HostContext`）；任何失败（加载、版本不等、create 抛错或超时、
 *   没有返回适配器）撤回该模块已注册的全部内容（#304）、只产生 warning 并跳过，不阻止启动（宿主适配器的失败规则不变）。
 * - 释放：按加载的逆序 dispose，失败只回调 onError。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { StartupError } from "../errors.js";
import { msg } from "../i18n/index.js";
import type { HostApiBinding } from "./api-impl.js";
import { createAdapter, disposeHost, loadHostModule } from "./loader.js";
import type { HostAdapterHandle } from "./types.js";

export const EXTENSIONS_DIR = "extensions";

const ENTRY_NAMES = ["index.mjs", "index.cjs"];

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 目录扩展的入口：`index.mjs`，其次 `index.cjs`；都没有时返回 `index.mjs`（加载时报「找不到」）。 */
export function resolveExtensionEntry(path: string): string {
  if (!isDir(path)) return path;
  return join(path, ENTRY_NAMES.find((n) => existsSync(join(path, n))) ?? "index.mjs");
}

/**
 * 用户级目录里的扩展（#305 起含目录）：单文件 `*.{mjs,cjs}` 与带 `index.{mjs,cjs}` 的子目录，
 * 按入口名（文件名或目录名）一起排序。目录不存在 → 空。
 */
export function discoverExtensionDir(configDir: string): string[] {
  const dir = join(configDir, EXTENSIONS_DIR);
  if (!existsSync(dir)) return [];
  let entries: { name: string; file: boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      // 常规文件与符号链接都先当文件看（链接指向目录时下面再按目录处理）
      file: e.isFile() || e.isSymbolicLink(),
    }));
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const { name, file } of entries) {
    const full = join(dir, name);
    if (isDir(full)) {
      if (ENTRY_NAMES.some((n) => existsSync(join(full, n)))) found.push(name);
    } else if (file && /\.(mjs|cjs)$/i.test(name)) {
      found.push(name);
    }
  }
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((name) => join(dir, name));
}

/** 加载顺序：用户级目录（按文件名），其后 profile `extensions`；同一路径只算一次。 */
export function discoverExtensions(
  configDir: string,
  profileExtensions: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of [
    ...discoverExtensionDir(configDir),
    ...profileExtensions.map((p) => (isAbsolute(p) ? p : resolve(p))),
  ]) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

export interface ExtensionSkip {
  path: string;
  reason: string;
}

export interface ActivateExtensionsInput {
  /** 要加载的文件（已经过信任决定）。 */
  paths: readonly string[];
  /** 每个模块一个新 binding（共享同一个 HostContext）。 */
  createBinding(): HostApiBinding;
  warn(message: string): void;
  timeoutMs?: number;
}

export interface ActivatedExtensions {
  handles: HostAdapterHandle[];
  skipped: ExtensionSkip[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 逐个激活；失败的只记 warning。 */
export async function activateExtensions(
  input: ActivateExtensionsInput,
): Promise<ActivatedExtensions> {
  const handles: HostAdapterHandle[] = [];
  const skipped: ExtensionSkip[] = [];
  const skip = (path: string, reason: string): void => {
    skipped.push({ path, reason });
    input.warn(msg().cli.bootstrap.extensionSkipped(path, reason));
  };
  for (const path of input.paths) {
    // [#304] 失败（抛错 / 超时 / 未返回适配器）一律撤回它已注册的内容；之后迟到的注册被忽略
    let binding: HostApiBinding | undefined;
    try {
      const module = await loadHostModule(resolveExtensionEntry(path));
      binding = input.createBinding();
      const adapter = await createAdapter(module, binding.api, path, input.timeoutMs);
      if (adapter === undefined) {
        binding.revoke();
        skip(path, msg().cli.bootstrap.extensionNotActivated);
        continue;
      }
      handles.push(binding.handle(adapter, path));
    } catch (error) {
      binding?.revoke();
      skip(path, error instanceof StartupError ? error.message : errorText(error));
    }
  }
  return { handles, skipped };
}

/** 逆序 dispose（每个失败只回调 onError，不影响其余）。 */
export async function disposeExtensions(
  handles: readonly HostAdapterHandle[],
  onError: (handle: HostAdapterHandle, error: unknown) => void = () => undefined,
): Promise<void> {
  for (const handle of [...handles].reverse()) {
    await disposeHost(handle, (error) => onError(handle, error));
  }
}
