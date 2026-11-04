/**
 * Pi 扩展的对话框 → ACP `elicitation/create`（#254）。
 *
 * 客户端声明了 `elicitation` 时，其它扩展经 RPC 发来的 select / confirm / input / editor 转成 form 型征询：
 * - select → 带标题的枚举（`oneOf`）；confirm → boolean；input / editor → string（editor 的预填作默认值）；
 * - `accept` → 把值回给 Pi；`decline` / `cancel` / 出错 → Pi 一侧 `cancelled: true`；
 * - 桥从不替人填表，也不挑选项。
 *
 * ama 自己的对话框（审批闸、拒绝理由、能力报告）不走这里；桥也不注册自己的 todo / 问卷工具——Pi 里没有对应
 * 扩展时，什么也不加，缺口体现在 `_meta["armadra.pi"].capabilities`。
 */

import type { AcpElicitationSchema } from "../../drivers/acp/types.js";
import { oneLine } from "../../drivers/turn.js";
import type { Json } from "./tools.js";

export interface ElicitationPlan {
  /** 给人看的说明（Pi 扩展给的标题，confirm 附上正文）。 */
  message: string;
  schema: AcpElicitationSchema;
  /** `accept` 的内容 → 回给 Pi 的 `extension_ui_response` 正文；内容不合就取消。 */
  toResponse(content: Record<string, unknown> | null | undefined): Json;
}

const CANCELLED: Json = { cancelled: true };

function label(record: Json, fallback: string): string {
  const title = record["title"];
  return typeof title === "string" && title !== "" ? oneLine(title, 200) : fallback;
}

/** 为一个 Pi 对话框请求建征询；不是四种对话框、或没有可选项的 select 返回 undefined（按取消处理）。 */
export function planElicitation(record: Json): ElicitationPlan | undefined {
  const method = String(record["method"] ?? "");
  const title = label(record, method);
  const string = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  switch (method) {
    case "select": {
      const options = Array.isArray(record["options"])
        ? (record["options"] as unknown[]).filter((o): o is string => typeof o === "string")
        : [];
      if (options.length === 0) return undefined;
      return {
        message: title,
        schema: {
          type: "object",
          properties: {
            value: { type: "string", title, oneOf: options.map((o) => ({ const: o, title: o })) },
          },
          required: ["value"],
        },
        toResponse: (content) => {
          const value = content?.["value"];
          return typeof value === "string" && options.includes(value) ? { value } : CANCELLED;
        },
      };
    }
    case "confirm": {
      const body = string(record["message"]);
      return {
        message: body !== undefined && body !== "" ? `${title}\n${oneLine(body, 400)}` : title,
        schema: {
          type: "object",
          properties: { confirmed: { type: "boolean", title, default: false } },
          required: ["confirmed"],
        },
        toResponse: (content) => ({ confirmed: content?.["confirmed"] === true }),
      };
    }
    case "input":
    case "editor": {
      const hint = string(record[method === "input" ? "placeholder" : "prefill"]);
      return {
        message: title,
        schema: {
          type: "object",
          properties: {
            value: {
              type: "string",
              title,
              ...(method === "input" && hint !== undefined && hint !== ""
                ? { description: oneLine(hint, 200) }
                : {}),
              ...(method === "editor" && hint !== undefined ? { default: hint } : {}),
            },
          },
          required: ["value"],
        },
        toResponse: (content) => {
          const value = content?.["value"];
          return typeof value === "string" ? { value } : CANCELLED;
        },
      };
    }
    default:
      return undefined;
  }
}

export const CANCELLED_RESPONSE: Json = CANCELLED;
