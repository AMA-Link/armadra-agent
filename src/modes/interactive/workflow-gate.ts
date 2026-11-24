/**
 * `/workflow` 的确认框：运行预览、gate、验证升级、保存确认。[#318]
 *
 * 界面只提供 `choose`（交互模式用底部确认框，line 模式用单键问答）；这里把它接成调度器要的
 * `onGate` / `onVerifyFailed`。取消（Esc）与运行被中止都按「拒绝 / 失败」处理，从不替人批准。
 */

import { msg } from "../../i18n/index.js";
import type {
  WorkflowGateAsker,
  WorkflowGateDecision,
  WorkflowVerifyAsker,
} from "../../workflows/run-types.js";
import { openChoice, type ChoiceHost } from "./confirm-dialog.js";

export interface ChooseSpec {
  title: string;
  body: readonly string[];
  /** 每项一个单键直选字母；最后一项是取消 / 拒绝一侧。 */
  options: readonly { label: string; key: string }[];
  selected: number;
}
/** 返回选中的下标；取消返回 undefined。 */
export type ChooseFn = (spec: ChooseSpec) => Promise<number | undefined>;

/** 交互模式：底部确认框。 */
export function dialogChooser(host: ChoiceHost): ChooseFn {
  return (spec) =>
    openChoice(host, {
      title: spec.title,
      body: spec.body,
      options: spec.options.map((o) => ({ label: o.label, keys: o.key })),
      selected: spec.selected,
    });
}

/** line 模式：单键问答（`ask` 返回小写的回答字符，Enter = 缺省）。 */
export function lineChooser(
  ask: (question: string, fallback: string) => Promise<string>,
  write: (text: string) => void,
): ChooseFn {
  return async (spec) => {
    write(`\n${[spec.title, ...spec.body.map((l) => `  ${l}`)].join("\n")}\n`);
    const keys = spec.options.map((o) => `[${o.key}] ${o.label}`).join("  ");
    const fallback = spec.options[spec.selected]?.key ?? "n";
    const answer = await ask(`${keys} `, fallback);
    const index = spec.options.findIndex((o) => o.key === answer);
    return index === -1 ? undefined : index;
  };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, aborted: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(aborted);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => resolve(aborted);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface WorkflowPrompts {
  confirm(title: string, body: readonly string[], yes: string, no: string): Promise<boolean>;
  gate: WorkflowGateAsker;
  verify: WorkflowVerifyAsker;
}

export function workflowPrompts(choose: ChooseFn): WorkflowPrompts {
  const m = msg().workflows;
  return {
    async confirm(title, body, yes, no) {
      const picked = await choose({
        title,
        body,
        options: [
          { label: yes, key: "y" },
          { label: no, key: "n" },
        ],
        selected: 1,
      });
      return picked === 0;
    },
    async gate(request, signal): Promise<WorkflowGateDecision> {
      const body = request.completed.map((c) => `${c.stepId}: ${c.summary}`);
      const picked = await raceAbort(
        choose({
          title: m.gate.title(request.label),
          body,
          options: [
            { label: m.gate.approve, key: "y" },
            { label: m.gate.reject, key: "n" },
          ],
          selected: 1,
        }),
        signal,
        undefined,
      );
      return picked === 0 ? "approve" : "reject";
    },
    async verify(failure, signal) {
      const picked = await raceAbort(
        choose({
          title: m.verify.title(failure.stepId, failure.summary),
          body: [],
          options: [
            { label: m.verify.accept, key: "y" },
            { label: m.verify.fail, key: "n" },
          ],
          selected: 1,
        }),
        signal,
        undefined,
      );
      return picked === 0 ? "accept" : "fail";
    },
  };
}
