/**
 * allow_session 会话记忆的粒度（设计 §7.1；从 pipeline.ts 拆出）：
 * bash 记命令的前两个词、web_fetch 记主机、[#270] 已注册的宿主资源记 `scheme://`、带 path 的工具记目录、
 * memory 与其它工具记工具名。`sessionGrantFor` 产生记忆，`grantCovers` 判断一次调用是否被覆盖。
 */

import { dirname, sep } from "node:path";
import { networkGrantHost } from "./network-class.js";
import {
  inputCommand,
  inputPath,
  inputResourcePrefix,
  normalizeCommand,
  splitShellSegments,
  type ResourceSchemes,
} from "./rules.js";

export interface SessionGrant {
  toolName: string;
  /** [#270] `resource`：本会话允许该 scheme（前缀 `scheme://`）。 */
  kind: "command" | "dir" | "host" | "resource" | "any";
  prefix: string;
}

export function sessionGrantFor(
  toolName: string,
  input: unknown,
  cwd: string,
  resources?: ResourceSchemes,
): SessionGrant {
  if (toolName === "memory") return { toolName, kind: "any", prefix: "" }; // [W6-M] 本会话允许全部写命令
  const host = networkGrantHost(input); // web_fetch：本会话允许该主机
  if (host !== undefined) return { toolName, kind: "host", prefix: host };
  const resource = inputResourcePrefix(input, resources); // [#270] 已注册资源：本会话允许该 scheme
  if (resource !== undefined) return { toolName, kind: "resource", prefix: resource };
  const command = inputCommand(input);
  if (command !== undefined) {
    const words = normalizeCommand(command).split(" ").slice(0, 2);
    return { toolName, kind: "command", prefix: words.join(" ") };
  }
  const path = inputPath(toolName, input, cwd, resources);
  if (path !== undefined) return { toolName, kind: "dir", prefix: dirname(path) };
  return { toolName, kind: "any", prefix: "" };
}

export function grantCovers(
  grant: SessionGrant,
  toolName: string,
  input: unknown,
  cwd: string,
  resources: ResourceSchemes,
): boolean {
  if (grant.toolName !== toolName) return false;
  if (grant.kind === "any") return true;
  if (grant.kind === "host") return networkGrantHost(input) === grant.prefix;
  if (grant.kind === "resource") return inputResourcePrefix(input, resources) === grant.prefix;
  if (grant.kind === "command") {
    const command = inputCommand(input);
    if (command === undefined || /\$\(|`/.test(command)) return false;
    const segments = splitShellSegments(command);
    return (
      segments.length > 0 &&
      segments.every((s) => s === grant.prefix || s.startsWith(`${grant.prefix} `))
    );
  }
  const path = inputPath(toolName, input, cwd, resources);
  return path !== undefined && (path === grant.prefix || path.startsWith(grant.prefix + sep));
}
