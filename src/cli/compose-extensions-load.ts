/**
 * 启动第 13 步的扩展部分（#301）：发现 → 按哈希信任决定 → 激活（失败只 warning）。宿主适配器先于它激活，
 * 资源注册表在它之后冻结。
 */

import { decideExtensions } from "../config/extension-trust.js";
import type { TrustPromptAnswer } from "../config/trust.js";
import { type HostApiDeps, type HostContext, createHostApi } from "../host/api-impl.js";
import { activateExtensions, discoverExtensions } from "../host/extensions.js";
import type { HostAdapterHandle } from "../host/types.js";
import { msg } from "../i18n/index.js";

export interface LoadExtensionsInput {
  configDir: string;
  profileExtensions: readonly string[];
  deps: HostApiDeps;
  context: HostContext;
  /** `--no-trust`。 */
  noTrust: boolean;
  interactive: boolean;
  prompt?:
    | ((files: readonly { path: string; sha256: string }[]) => Promise<TrustPromptAnswer>)
    | undefined;
  warn(message: string): void;
}

export async function loadExtensions(input: LoadExtensionsInput): Promise<HostAdapterHandle[]> {
  const found = discoverExtensions(input.configDir, input.profileExtensions);
  if (found.length === 0) return [];
  const decision = await decideExtensions({
    paths: found,
    configDir: input.configDir,
    disabled: input.noTrust,
    interactive: input.interactive,
    prompt: input.prompt,
  });
  const m = msg().cli.bootstrap;
  for (const skipped of decision.skipped) {
    input.warn(m.extensionSkipped(skipped.path, m.extensionReason[skipped.reason]));
  }
  const { handles } = await activateExtensions({
    paths: decision.load,
    createBinding: () => createHostApi(input.deps, input.context),
    warn: input.warn,
  });
  return handles;
}
