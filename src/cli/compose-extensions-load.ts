/**
 * 启动第 13 步的扩展部分（#301）：发现 → 按哈希信任决定 → 激活（失败只 warning）。宿主适配器先于它激活，
 * 资源注册表在它之后冻结。
 */

import { decideExtensions, type ExtensionPromptFile } from "../config/extension-trust.js";
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
  prompt?: ((files: readonly ExtensionPromptFile[]) => Promise<TrustPromptAnswer>) | undefined;
  warn(message: string): void;
}

export async function loadExtensions(input: LoadExtensionsInput): Promise<HostAdapterHandle[]> {
  const found = discoverExtensions(input.configDir, input.profileExtensions);
  if (found.length === 0) return [];
  // 读 / 写 trust.json 或询问界面出错：全部跳过并 warning，不让扩展的问题变成启动失败（宿主已激活）
  let decision: Awaited<ReturnType<typeof decideExtensions>>;
  try {
    decision = await decideExtensions({
      paths: found,
      configDir: input.configDir,
      disabled: input.noTrust,
      interactive: input.interactive,
      prompt: input.prompt,
    });
  } catch (error) {
    input.warn(
      msg().cli.bootstrap.extensionsTrustFailed(
        error instanceof Error ? error.message : String(error),
      ),
    );
    return [];
  }
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
