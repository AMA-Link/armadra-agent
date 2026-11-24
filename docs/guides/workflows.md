# 多 Agent 工作流

工作流是一份 Markdown 文件：几个角色（每个角色是一个 Agent，可以是 ama 自己的子 Agent，也可以是 Claude Code、Codex 等外部 Agent），
几步按依赖关系排好的任务，可选的人工审批点与自动验证。ama 按文件调度：不同角色并行，同一角色的步骤串行并续聊同一个任务，
最后把没有后继的步骤的输出交给你。同一份文件也能交给 [Armadra](https://github.com/AMA-Link/Armadra) 画布执行。

调度语义的细节（并发、预算、记录）见 [agents.md](agents.md)「工作流调度与保存」；本文讲文件怎么写、怎么运行。

## 文件与位置

一个工作流 = 一个 `*.md` 文件，id 就是文件名去掉 `.md`（以字母开头，字母、数字、`_`、`-`，最长 32 个字符）。只看目录的直接下层，按下面的顺序发现，同 id 先发现者胜：

| 顺序 | 位置                     | scope     |
| ---- | ------------------------ | --------- |
| 1    | config `workflows.dirs`  | `config`  |
| 2    | `<configDir>/workflows/` | `user`    |
| 3    | `<项目>/.ama/workflows/` | `project` |

项目目录需要信任：未信任的项目被跳过并提示一次。无效文件不会加载，在列表里标为无效并带原因。

文件由 YAML frontmatter 与正文组成。frontmatter 是工作流本身（`version: 2`），正文是给人看的说明（`/workflow show` 显示，不发给任何模型）；
frontmatter 里不能再写 `description`。

## 字段

| 字段                     | 说明                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                | 固定 `2`                                                                                                                                                                    |
| `title`                  | 标题                                                                                                                                                                        |
| `params`                 | 参数：`name`、`type`（`string` \| `path` \| `text`）、`label?`、`default?`；prompt 里用 `{{name}}` 引用                                                                     |
| `roles[]`                | 角色：`id`、`agentId`（`ama`、`claude`、`codex`、`acp:…`、宿主 runner；`ama` 单独运行时是 `general` 子 Agent）、`tier?`、`model?`、`worktree?`、`permissionMode?`、`title?` |
| `roles[].tier` / `model` | 档位（`light` \| `standard` \| `strong` \| `max`，见 [agents.md](agents.md)）；`model` 显式指定，优先于 `tier`                                                              |
| `roles[].worktree`       | 非空则该角色在独立 git worktree 里工作                                                                                                                                      |
| `roles[].permissionMode` | `plan` = 只读；`default` / `auto-edit` / `full-auto` 不放宽，仍继承会话模式                                                                                                 |
| `links`                  | 角色间的沟通关系 `{ from, to }`，供画布使用                                                                                                                                 |
| `contract.text`          | 各方共守的约定（接口、约束）；放进每个角色的第一条消息                                                                                                                      |
| `contract.owns`          | `{ 角色: [glob, …] }`：该角色只改这些路径；不同角色的 glob 不能重叠                                                                                                         |
| `steps[]`                | 步骤：`id`、`kind`（`prompt` \| `collect` \| `gate`）、`role`、`prompt`、`after?`、`from?`、`verify?`、`maxRetries?`、`label?`                                              |
| `steps[].kind: prompt`   | 让角色执行一条提示；prompt 代入参数后最长 2000 个字符                                                                                                                       |
| `steps[].kind: collect`  | 汇总：`from` 列出要收集的步骤，它们的输出作为 `<step-output>` 块附在提示后面                                                                                                |
| `steps[].kind: gate`     | 人工审批点，没有 `role` 与 `prompt`，用 `label` 说明要审什么                                                                                                                |
| `steps[].after`          | 依赖：所有 `after` 步骤完成后才开始；不写 = 起始步骤                                                                                                                        |
| `steps[].verify`         | 只用于 `collect`：`commands`（要通过的命令）与 `checklist`（人读的检查项）                                                                                                  |
| `steps[].maxRetries`     | 验证不过时最多退回几轮（0–3，缺省 2）；只能与 `verify` 同写                                                                                                                 |

长度规则：`collect` 步骤、以及工作流有 `contract` 时的 `prompt` 步骤，代入后长度加 200 不得超过 2000，因为 ama 会在后面附上约定块与来源输出；其余 `prompt` 步骤不超过 2000。违反时起跑前以 `prompt_too_long` 拒绝，不起任何任务。

## 示例

`test/fixtures/workflows/valid-full.md`（API 与 UI 并行，审批后合并并验证）：

```markdown
---
version: 2
title: Split a feature into API and UI
params:
  - name: feature
    type: text
    label: What to build
roles:
  - id: api
    agentId: ama
    tier: strong
    worktree: api
  - id: ui
    agentId: ama
    tier: standard
    worktree: ui
  - id: lead
    agentId: ama
    tier: strong
contract:
  text: |
    Interface: POST /api/items -> { id: string }
    Constraint: no new runtime dependencies.
  owns:
    api: ["src/server/"]
    ui: ["src/web/**"]
steps:
  - id: build-api
    kind: prompt
    role: api
    prompt: "Implement the server side of {{feature}}."
  - id: build-ui
    kind: prompt
    role: ui
    prompt: "Implement the UI of {{feature}} against the contract."
  - id: review
    kind: gate
    label: Review both parts before merging
    after: [build-api, build-ui]
  - id: integrate
    kind: collect
    role: lead
    from: [build-api, build-ui]
    after: [review, build-api, build-ui]
    prompt: Merge both branches and summarize what changed.
    verify:
      commands: ["pnpm test"]
      checklist: ["The API route exists", "The UI calls it"]
    maxRetries: 1
---

For people: this workflow builds the API and the UI in parallel.

It is never sent to a model.
```

## `/workflow` 命令

交互界面与 line 模式都有（见 [tui.md](tui.md)）：

| 命令                                | 作用                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/workflow list`                    | 列出 id、标题、步数与 scope；无效文件带原因；未信任而跳过的目录提示一行                                  |
| `/workflow show <id>`               | 参数、角色（Agent、档位对应的模型）、步骤依赖、约定与正文                                                |
| `/workflow run <id> [name=value …]` | 预览后运行；参数写成 `name=value`，值有空格时加引号                                                      |
| `/workflow save [id] [--user]`      | 把本会话的深度 1 子任务整理成工作流草案，预览确认后写到项目（`--user` 写到用户配置目录），不覆盖已有文件 |
| `/workflow cancel`                  | 取消本会话正在运行的工作流                                                                               |

`run` 先显示预览：每个角色一行（档位对应的模型与每步的估算美元）、步骤数与审批点数，确认后才起跑。运行中每个步骤的开始与结束各显示一行进度。
遇到 `gate` 或验证升级时弹出确认框（line 模式是选择提示）：

- `gate`：批准则继续，拒绝则运行以 `gate_rejected` 失败。
- 验证升级：批准 = 接受结果（带警告完成），拒绝 = 失败（`verify_failed`）。

交给 Armadra 画布时显示画布给的链接，之后在画布里执行、审批、记账，ama 不再更新进度。

## 无人值守：`ama -p --workflow`

```bash
ama -p --workflow feature-split --param feature="add an items endpoint"
```

- 不接受位置提示与 `-`；`--param` 可重复，同名参数给两次是用法错误；`--param` 必须与 `--workflow` 同用。
- 没有人能审批：`gate` 按 `workflows.unattendedGate`（缺省 `reject`，项目级只能写 `reject`）；验证升级一律失败，`approve` 不放行它。
- `text`：成功时 stdout 打印没有后继的非 gate 步骤的最终文本，多段以空行分隔；交给画布时打印链接或运行 id。
- `json`：stdout 一个 `result` 对象，带 `workflowId`、`workflow`（运行结果）与收到的 `workflowUpdates`。
- `stream-json`：每个会话事件一行（含 `workflow_update`），最后接一行同样的 `result`。

| 退出码 | 含义                                                              |
| ------ | ----------------------------------------------------------------- |
| 0      | 成功，或已交给画布                                                |
| 1      | 步骤失败或验证失败                                                |
| 2      | 找不到工作流、文件无效、参数错误、起跑检查不通过                  |
| 8      | 到达 `--max-cost` / `--max-turns` / `limits.*`（`limit_reached`） |
| 10     | `gate` 被拒、无人值守停在 `gate`，或画布要求人工确认              |

## SDK

```ts
import { createAgentSession, listWorkflows, runWorkflow } from "@armadra/agent";

const summaries = listWorkflows({ cwd, configDir, trusted: true }); // 含无效文件及原因
const session = await createAgentSession({ cwd });
const handle = runWorkflow(session, "feature-split", {
  params: { feature: "add an items endpoint" },
  onGate: async (request) => "approve",
  onVerifyFailed: async (request) => "fail",
  onUpdate: (update) => console.log(update.status),
  limits: { maxCostUsd: 5 },
});
const result = await handle.wait(); // WorkflowRunResult：status、outputs、error?、host?
```

`listWorkflows` 没有会话，`trusted` 缺省 `true`、`configDir` 缺省用户级配置目录；`runWorkflow` 缺省取会话创建时的配置目录与信任（`createAgentSession` 的会话总是受信任），也可以显式覆盖。
第二个参数也可以是一份内联的工作流文档（`WorkflowDocument`），内联文档一律在本进程里运行。没有 `onGate` 时 `gate` 按 `unattendedGate`（缺省 `reject`）。
类型与纯函数见 `@armadra/agent/workflow`（[agents.md](agents.md)）。

## RPC

`get_workflows`、`run_workflow { workflowId, params? }`、`respond_workflow_gate`、`cancel_workflow`，进度走 `workflow_update` 事件；
客户端声明 `workflow_gates` 能力才会等它回答 `gate` 与验证升级。形状见 [rpc.md](../reference/rpc.md)「工作流」。
ACP 客户端把每个步骤看成一个合成的工具调用，见 [acp.md](../reference/acp.md)「事件映射」。

## 交给 Armadra 画布

装了 Armadra 宿主适配器、且宿主声明支持版本 2 时，来自文件的工作流只交出并起跑：画布执行、记账、问人，ama 不镜像进度也不能取消（`/workflow cancel` 提示到画布里取消）。
只有项目级（`project`）工作流直接起跑；用户级与 `config` 级的由画布生成草案卡让人确认，此时 ama 返回「等待确认」，`-p` 以退出码 10 结束。
宿主版本不匹配时回落到本进程运行并写一条警告。

## 验证、退回与升级

`collect` 步骤带 `verify` 时，ama 在汇总提示后附上验证说明，要求角色逐项检查并用 `report` 报告：

- `report` 为 `ready` 才算通过；为 `failed` 或 `blocked` 则不通过。
- 不通过且还没用完 `maxRetries`：按报告摘要里的 `[<角色>]` 前缀找到问题所属的角色，只把它的步骤退回去修；没点名则退回 `from` 里的全部角色。修好后汇总角色重新收集并再验证。
- 没有 `report`（含外部 Agent 没给）视为未验证，不重试，直接升级。
- 升级（重试用尽、未验证、角色任务无法续聊）：有人可问时由人决定接受或失败；没有人（`-p`、没声明 `workflow_gates` 的 RPC）时直接 `verify_failed`。

## 预算

运行的总花费与总回合（含所有任务及其后代）受 `limits.*`、`--max-cost`、`--max-turns` 约束。每个步骤（含重试与退回）起跑前检查，已达上限则该步失败、运行以 `limit_reached` 结束，在跑的任务照常跑完，`-p` 退出码 8。

## 已知限制

- 进度行只在 `/workflow run` 起跑时显示；之后新开的界面不会补显示。
- line 模式下运行期间输入的 `/workflow cancel` 被当作插话，要停止请按 Ctrl+C。
- 一个会话同时只能有一个单独运行（再起得 `workflow_busy`）；交给画布的不受此限。
- 工作流任务不转后台，模型也不能用 `task_ctl` 续聊它们。
