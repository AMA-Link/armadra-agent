/**
 * 桥的四个权限模式与审批判定（#254）。
 *
 * Pi 没有权限模式，所以由 ama 加载的扩展（`drivers/native/pi-extension.ts`）在每次工具调用前把请求交给桥，
 * 桥按当前模式判定：**每次调用都问桥**，`session/set_mode` 立即生效（不靠 `--tools`）。
 *
 * - `default`：只读以外都交给人；
 * - `auto-edit`：放行 `edit` / `write`，其余只读以外交给人；
 * - `plan`：放行只读内置工具与带 `readOnlyHint` 的 MCP 工具，其余拒绝并告诉模型现在在 plan 模式；
 * - `full-auto`：都放行，但命中 ama 危险命令规则的 bash 仍交给人。
 *
 * 判定只产生「放行 / 拒绝 / 交给人」；交给人时请求只发给客户端，桥从不代答。
 */

import { matchDangerous } from "../../permissions/dangerous.js";
import type { Json } from "./tools.js";
import { PI_READ_ONLY_TOOLS } from "../../drivers/native/pi-extension.js";

/** 桥的模式 id（与 ama 的权限模式同名）。 */
export type BridgeMode = "default" | "auto-edit" | "plan" | "full-auto";

/** `availableModes` 的顺序（严格的在前，与 ama 的选择器一致）。 */
export const BRIDGE_MODES: readonly BridgeMode[] = ["default", "auto-edit", "plan", "full-auto"];

export function isBridgeMode(value: string): value is BridgeMode {
  return (BRIDGE_MODES as readonly string[]).includes(value);
}

/** 审批闸发来的一次调用（扩展按固定形状序列化）。 */
export interface GateCall {
  id: string;
  tool: string;
  input: Json;
  /** 工具声明了 `readOnlyHint`。 */
  readOnly: boolean;
  /** codemode 等父调用的 id。 */
  parent?: string;
}

export type Verdict =
  | { kind: "allow" }
  | { kind: "ask" }
  /** `reason` 回给模型（固定英文）。 */
  | { kind: "deny"; reason: string };

/** 解析扩展发来的正文；形状不对返回 undefined（调用方按拒绝处理）。 */
export function parseGateCall(message: unknown): GateCall | undefined {
  if (typeof message !== "string") return undefined;
  let raw: Json;
  try {
    raw = JSON.parse(message) as Json;
  } catch {
    return undefined;
  }
  if (typeof raw["id"] !== "string" || typeof raw["tool"] !== "string") return undefined;
  const input =
    raw["input"] !== null && typeof raw["input"] === "object" ? (raw["input"] as Json) : {};
  return {
    id: raw["id"],
    tool: raw["tool"],
    input,
    readOnly: raw["readOnly"] === true,
    ...(typeof raw["parent"] === "string" ? { parent: raw["parent"] } : {}),
  };
}

const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

/** 命中 ama 危险命令规则的 shell 调用。 */
function isDangerousShell(call: GateCall): boolean {
  const command = call.input["command"];
  return (
    SHELL_TOOLS.has(call.tool) &&
    typeof command === "string" &&
    matchDangerous(command) !== undefined
  );
}

export function verdictFor(mode: BridgeMode, call: GateCall): Verdict {
  const readOnly = call.readOnly || PI_READ_ONLY_TOOLS.includes(call.tool);
  switch (mode) {
    case "plan":
      return readOnly
        ? { kind: "allow" }
        : {
            kind: "deny",
            reason: `${call.tool} was blocked: this session is in plan mode, which only allows read-only tools. Describe the change in your reply instead of making it.`,
          };
    case "full-auto":
      return isDangerousShell(call) ? { kind: "ask" } : { kind: "allow" };
    case "auto-edit":
      return readOnly || EDIT_TOOLS.has(call.tool) ? { kind: "allow" } : { kind: "ask" };
    default:
      return readOnly ? { kind: "allow" } : { kind: "ask" };
  }
}
