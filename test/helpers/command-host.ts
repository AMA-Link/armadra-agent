import type { TmpHome } from "./tmp-home.js";

/**
 * 注册四个扩展命令的 CJS 宿主适配器（#303 的 -p / ACP 测试共用）：
 * `standup`（handled + message，args 作占位提示）、`brief`（prompt）、`quiet`（handled 无 message）、`boom`（抛错）。
 * 返回 `--host` 路径。
 */
export function commandHost(home: TmpHome): string {
  return home.write(
    "work/host-commands.cjs",
    `module.exports = { hostApi: 1, create(api) {
  api.commands.register({ name: "standup", description: "Summarize", args: "[day]",
    run: (args) => ({ kind: "handled", message: "standup:" + args }) });
  api.commands.register({ name: "brief", description: "Brief",
    run: (args) => ({ kind: "prompt", text: "Brief for " + args }) });
  api.commands.register({ name: "quiet", description: "Quiet", run: () => undefined });
  api.commands.register({ name: "boom", description: "Boom", run: () => { throw new Error("kaboom"); } });
  return { id: "commands" };
} };`,
  );
}
