/**
 * 消息目录：workflows（`/workflow` 命令与工作流运行，多 Agent 工作流设计稿 §5.9）。[#318]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`。只放给人看的界面文案；发给模型的步骤提示、
 * 错误文案（§4.9）固定英文，不走这里。
 */

import type { Messages } from "../types.js";
import { plural } from "../format.js";

export const en = {
  usage: "/workflow list | show <id> | run <id> [name=value …] | save [id] [--user] | cancel",
  list: {
    empty: "No workflows. Add .ama/workflows/<id>.md or save one with /workflow save.",
    line: (id: string, title: string, steps: number, scope: string) =>
      `${id} — ${title} (${plural(steps, "step")}, ${scope})`,
    invalid: (path: string, reason: string) => `${path}: ${reason}`,
    untrusted: (dir: string) => `Skipped ${dir}: this project is not trusted`,
  },
  scope: { project: "project", user: "user", config: "extra dir" },
  notFound: (id: string) => `No workflow named ${id}.`,
  show: {
    params: "Parameters",
    roles: "Roles",
    steps: "Steps",
    contract: "Contract",
    description: "Description",
  },
  preview: {
    title: (id: string) => `Run workflow ${id}?`,
    role: (role: string, target: string, tier?: string) =>
      `${role}: ${target}${tier === undefined ? "" : ` · ${tier}`}`,
    cost: (usd: string) => `≈ ${usd} per step`,
    noCost: "price unknown",
    summary: (steps: number, gates: number) => `${plural(steps, "step")}, ${plural(gates, "gate")}`,
    run: "Run",
    cancel: "Cancel",
  },
  run: {
    started: (id: string, runId: string) => `Workflow ${id} started (${runId}).`,
    handedOff: (id: string, link: string) => `Workflow ${id} was handed to the host: ${link}`,
    step: (stepId: string, status: string) => `${stepId}: ${status}`,
    finished: (id: string, status: string) => `Workflow ${id} ${status}.`,
    busy: "A workflow is already running in this session.",
    nothingToCancel: "No workflow is running.",
    cancelled: (id: string) => `Workflow ${id} cancelled.`,
  },
  status: {
    running: "running",
    waiting: "waiting",
    succeeded: "succeeded",
    failed: "failed",
    cancelled: "cancelled",
  },
  stepStatus: {
    pending: "pending",
    running: "running",
    waiting: "waiting",
    done: "done",
    failed: "failed",
    skipped: "skipped",
    cancelled: "cancelled",
  },
  phase: {
    running: "running",
    waiting_children: "waiting for sub-tasks",
    collecting: "collecting",
    verifying: "verifying",
    waiting_human: "waiting for you",
  },
  gate: {
    title: (label: string) => `Gate: ${label}`,
    approve: "Approve",
    reject: "Reject",
  },
  verify: {
    title: (stepId: string, summary: string) =>
      `Step ${stepId} did not pass verification: ${summary}`,
    accept: "Accept anyway",
    fail: "Mark failed",
  },
  save: {
    save: "Save",
    needsUi: "Saving a workflow needs an interactive session to confirm.",
    confirm: (path: string) => `Save workflow to ${path}?`,
    saved: (path: string) => `Saved ${path}`,
    nothing: "No sub-agent tasks in this session to turn into a workflow.",
    exists: (path: string) => `${path} already exists; choose another id.`,
  },
  param: {
    bad: (text: string) => `Parameters are name=value (got "${text}").`,
  },
};

export const zh = {
  usage: "/workflow list | show <id> | run <id> [名=值 …] | save [id] [--user] | cancel",
  list: {
    empty: "没有工作流。添加 .ama/workflows/<id>.md，或用 /workflow save 保存一份。",
    line: (id: string, title: string, steps: number, scope: string) =>
      `${id} — ${title}（${steps} 步，${scope}）`,
    invalid: (path: string, reason: string) => `${path}: ${reason}`,
    untrusted: (dir: string) => `已跳过 ${dir}：项目未受信任`,
  },
  scope: { project: "项目", user: "用户", config: "附加目录" },
  notFound: (id: string) => `没有名为 ${id} 的工作流。`,
  show: {
    params: "参数",
    roles: "角色",
    steps: "步骤",
    contract: "契约",
    description: "说明",
  },
  preview: {
    title: (id: string) => `运行工作流 ${id}？`,
    role: (role: string, target: string, tier?: string) =>
      `${role}: ${target}${tier === undefined ? "" : ` · ${tier}`}`,
    cost: (usd: string) => `约 ${usd} / 步`,
    noCost: "价格未知",
    summary: (steps: number, gates: number) => `${steps} 步，${gates} 个关口`,
    run: "运行",
    cancel: "取消",
  },
  run: {
    started: (id: string, runId: string) => `工作流 ${id} 已开始（${runId}）。`,
    handedOff: (id: string, link: string) => `工作流 ${id} 已交给宿主：${link}`,
    step: (stepId: string, status: string) => `${stepId}: ${status}`,
    finished: (id: string, status: string) => `工作流 ${id} ${status}。`,
    busy: "本会话已有工作流在运行。",
    nothingToCancel: "没有在运行的工作流。",
    cancelled: (id: string) => `工作流 ${id} 已取消。`,
  },
  status: {
    running: "运行中",
    waiting: "等待中",
    succeeded: "成功",
    failed: "失败",
    cancelled: "已取消",
  },
  stepStatus: {
    pending: "待运行",
    running: "运行中",
    waiting: "等待中",
    done: "完成",
    failed: "失败",
    skipped: "跳过",
    cancelled: "已取消",
  },
  phase: {
    running: "运行中",
    waiting_children: "等待子任务",
    collecting: "汇总中",
    verifying: "验证中",
    waiting_human: "等你决定",
  },
  gate: {
    title: (label: string) => `关口：${label}`,
    approve: "批准",
    reject: "拒绝",
  },
  verify: {
    title: (stepId: string, summary: string) => `步骤 ${stepId} 没通过验证：${summary}`,
    accept: "仍然接受",
    fail: "记为失败",
  },
  save: {
    save: "保存",
    needsUi: "保存工作流需要在交互界面里确认。",
    confirm: (path: string) => `保存工作流到 ${path}？`,
    saved: (path: string) => `已保存 ${path}`,
    nothing: "本会话没有可整理成工作流的子任务。",
    exists: (path: string) => `${path} 已存在，请换一个 id。`,
  },
  param: {
    bad: (text: string) => `参数写成 名=值（收到的是「${text}」）。`,
  },
} satisfies Messages<typeof en>;
