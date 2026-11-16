/**
 * 启动第 13 步的扩展部分（#301）：发现 → 激活（失败只 warning）。宿主适配器先于它激活，
 * 资源注册表在它之后冻结。信任决定见 config/extension-trust.ts（接入同一入口）。
 */

import {
  createHostApi,
  createHostContext,
  type HostApiDeps,
  type HostContext,
} from "../host/api-impl.js";
import { activateExtensions, discoverExtensions } from "../host/extensions.js";
import type { HostAdapterHandle } from "../host/types.js";

export interface LoadExtensionsInput {
  configDir: string;
  profileExtensions: readonly string[];
  deps: HostApiDeps;
  context: HostContext;
  warn(message: string): void;
}

export async function loadExtensions(input: LoadExtensionsInput): Promise<HostAdapterHandle[]> {
  const paths = discoverExtensions(input.configDir, input.profileExtensions);
  if (paths.length === 0) return [];
  const { handles } = await activateExtensions({
    paths,
    createBinding: () => createHostApi(input.deps, input.context),
    warn: input.warn,
  });
  return handles;
}

export { createHostContext };
