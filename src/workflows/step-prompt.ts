/**
 * [#318] 工作流步骤发给模型的固定英文片段（设计稿 §4.5）。纯函数；不得 import `src/i18n`。
 */
import type { WorkflowContract, WorkflowVerify } from "./types.js";

export function contractBlock(c: WorkflowContract, roleId: string): string {
  const text = (c.text ?? "").trim();
  const owns = c.owns?.[roleId] ?? [];
  if (text === "" && owns.length === 0) return "";
  const lines = ["<contract>"];
  if (text !== "") lines.push(text);
  if (owns.length > 0) lines.push(`Files you own (edit only these): ${owns.join(", ")}`);
  lines.push("</contract>");
  return lines.join("\n");
}

export const STEP_OUTPUT_MAX_CHARS = 8000;

/** 超过上限时各留头尾一半（按码点），末行写全文所在文件。 */
export function stepOutputBlock(
  stepId: string,
  roleId: string,
  text: string,
  outputFile?: string,
): string {
  const chars = [...text];
  let body = text;
  if (chars.length > STEP_OUTPUT_MAX_CHARS) {
    const half = STEP_OUTPUT_MAX_CHARS / 2;
    body =
      `${chars.slice(0, half).join("")}\n...\n${chars.slice(-half).join("")}\n` +
      (outputFile === undefined ? "(truncated)" : `(truncated; full output: ${outputFile})`);
  }
  return `<step-output step="${stepId}" role="${roleId}">\n${body}\n</step-output>`;
}

export function verifyInstruction(v: WorkflowVerify, fromRoles: readonly string[]): string {
  const lines = ["Before you finish, verify the result:"];
  for (const command of v.commands ?? []) {
    lines.push(`- run \`${command}\` and make sure it succeeds`);
  }
  for (const item of v.checklist ?? []) lines.push(`- ${item}`);
  lines.push(
    "Then call report: state ready only if every check passed; otherwise state failed and, in the " +
      "summary, start each problem with the role it belongs to, one of " +
      `${fromRoles.map((r) => `[${r}]`).join(" ")}.`,
  );
  return lines.join("\n");
}

export function fixMessage(
  collectStepId: string,
  attempt: number,
  max: number,
  problems: string,
): string {
  return (
    `The collect step ${collectStepId} found problems in your part (attempt ${attempt} of ${max}):\n` +
    `${problems}\nFix them, then end with your report.`
  );
}

export function recollectMessage(attempt: number, max: number): string {
  return (
    `The problems were sent back and fixed (attempt ${attempt} of ${max}). Collect again from the ` +
    "updated outputs below and verify again."
  );
}
