# 本地扩展

用户自己安装、可以有多个的宿主适配器：在进程内观察事件、注册工具与斜杠命令、在界面上给出通知与状态，而不占用宿主（`--host` / profile `host`，如 Armadra 画布）的位置。命令式 Hook（[hooks.md](hooks.md)）只能在固定时机跑外部命令，扩展补上进程内的这一层。

扩展与宿主适配器是**同一个模块形状**：`HostModule`（`hostApi` + `create(api)`），拿到的是同一个 `HostApi`，类型与各成员的细节见 [host-api.md](../reference/host-api.md)。本文只讲扩展特有的部分：加载、共存规则、斜杠命令、信任与 `ama doctor`。

## 写一个扩展

```js
// ~/.config/ama/extensions/standup.mjs
export const hostApi = 1;

export function create(api) {
  api.commands.register({
    name: "standup",
    description: "Summarize today's work",
    args: "[day]",
    run(args, ctx) {
      return {
        kind: "prompt",
        text: `Summarize what we did in ${ctx.session.cwd()} ${args || "today"}.`,
      };
    },
  });
  api.events.on("agent_settled", () => api.ui.setStatus("standup", "ready"));
  return { id: "standup" };
}
```

模块可以是 `.mjs`（ESM）或 `.cjs`；导出 `default` 或具名的 `hostApi` + `create` 都行。`create()` 返回的适配器必须有 `id`，可以带 `dispose()`（退出时调用）。返回 `undefined` 表示不启用。

## 位置与加载

- **用户级目录**：`<configDir>/extensions/` 下的单文件 `*.{mjs,cjs}` 与**目录扩展** `<名>/index.{mjs,cjs}`（`index.mjs` 优先），一起按入口名（文件名或目录名）排序（缺省 `~/.config/ama/extensions/`，`AMA_CONFIG_DIR` 可改）。没有 `index.*` 的子目录忽略。
- **profile**：`extensions: ["/abs/a.mjs", "/abs/dir-ext", …]`（绝对路径，可以是目录扩展），排在用户级目录之后；同一路径只加载一次。
- **不支持项目级**：仓库里的 `.ama/extensions/` 不加载。扩展以进程权限运行、能注册工具，等同于执行任意代码，不随仓库分发。
- **顺序**：宿主适配器最先激活；扩展在它之后、组装会话之前（启动第 13 步）。

## 共存规则

每个模块有独立的 `HostApi` 实例（各自的工具清单与状态键），共享同一个工具注册表、事件总线、审批 broker 槽、资源注册表与保温处理器。

| 面                            | 多个模块共存时                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `tools.register`              | 先到先得；同名时后来者抛 `tool_exists`（扩展可以自己捕获；不捕获则 `create()` 失败，整个扩展被跳过）                           |
| `tools.disable`               | 累加                                                                                                                           |
| `instructions.add`            | 按加载顺序（宿主适配器在前）追加到系统提示的 `host` 节                                                                         |
| `events.on`                   | 都收到，按注册顺序依次调用                                                                                                     |
| `approvals.setBroker`         | 只认第一个设置者（通常是宿主适配器）；其余调用忽略并 warning。同一个模块可以再次设置覆盖自己                                   |
| `ui.notify` / `ui.setStatus`  | 都可用；状态栏把各模块的键合并显示，同名键后加载的覆盖先加载的，所以键名建议带自己的前缀                                       |
| `cache.onWarmingDecision`     | 跨模块最后注册且未注销的处理器生效                                                                                             |
| `commands.register`           | 见下节；命令名全局唯一，先注册先得                                                                                             |
| `runners.provide` / `onDone`  | 共享一张 runner 表，先到先得（同 id 后来者抛 `runner_exists`）；`onDone` 只回调本模块的 runner；有无宿主适配器都被 `task` 使用 |
| `create()` 失败 / 超时        | 宿主适配器失败仍是退出码 6；**扩展失败只记 warning 并跳过**，不阻止启动                                                        |
| 加载失败 / `hostApi` 版本不等 | 宿主适配器仍是退出码 78 / 6；扩展跳过并 warning                                                                                |
| 退出                          | 按加载的逆序 `dispose`（扩展先、宿主适配器最后），某个失败只记 warning                                                         |

没有扩展时，系统提示与工具表与以前逐字节相同。Hook 公共字段里的 `host` 仍是宿主适配器的 id，扩展不改它。

扩展的 `create()` 抛错、超时或没有返回适配器时，它此前注册的全部内容都会被撤回：工具（禁用的工具恢复）、事件订阅、命令、指令、状态键、保温处理器、自己持有的 broker、runner 与资源。撤回之后该模块再调用注册类方法（例如超时后迟到的注册）一律忽略并写 warning。

## 子 Agent runner

`api.runners.provide(runner)` 在宿主适配器与扩展之间共用一张表，`task(agent=<id>)`、`/agents` 与 RPC `get_agents` 都读它：

- 同 id 先到先得，后来者抛 `runner_exists`；注销或模块被撤回后 id 可再提供。
- 没有宿主适配器时扩展的 runner 同样生效，与宿主注入的同等优先（同 id 会替换内置的外部 runner，如 `claude`）；“有宿主适配器时 ama 不自起外部 CLI”的判定仍只看宿主适配器，扩展不改变它。
- `api.runners.onDone(handler)` 只回调本模块自己提供的 runner。

## 斜杠命令

`api.commands.register({ name, description, args?, run(args, ctx) })`（host-api 1.4，可选成员，用前判断 `api.commands !== undefined`），宿主适配器与扩展都可用，返回注销函数。

- **名字**：`^[a-z][a-z0-9-]{0,63}$`，不带斜杠。与内置命令、别名（`quit`、`q`、`?`）、交互界面命令（`tree`、`permissions`）同名，或与已注册的命令同名，注册时抛错。
- **分派**：内置命令之后、提示模板之前。同名的提示模板被扩展命令遮住。`/skill:<名>` 不受影响。
- **`args`**：命令名之后的整段文本（已去掉首尾空白）；`description` 与 `args`（占位提示，如 `"[day]"`）显示在 `/help` 与补全里。不做参数补全。
- **`ctx`**：刻意很小——`{ mode, session: { id(), cwd() } }`。要更多能力（发消息、读状态）用注册时拿到的 `api`。
- **返回值**：`{ kind: "handled", message? }`（`message` 显示给用户，不进对话）或 `{ kind: "prompt", text }`（改发这段文本作为用户提示）；返回 `undefined` 等同 `{ kind: "handled" }`；其它形状按错误处理，`run` 自己抛的错也按错误显示，不影响会话。
- **在哪些模式可用**：交互、line、RPC、`-p`、ACP。提示整段形如 `/名 参数` 且命中扩展命令时在 ama 内分派，`prompt` 一律改发其 `text`；`handled` 按模式给出 `message`，都不开模型回合：
  - RPC：`message` 作为 `notification` 事件发出，返回 `disposition: "handled"`。
  - `-p`：`message` 写到 stdout 后退出 0（`--output-format text` 原样输出，`json` 与 `stream-json` 给一行 `result` 对象，`text` 是 `message`、用量为 0）；`run` 抛错时 stderr 一行 `ama: <错误>`，退出码 1。
  - ACP：`message` 作为一条 `agent_message_chunk` 发出，`session/prompt` 以 `end_turn` 结束（用量为 0）；`run` 抛错时 `session/prompt` 答复 internal error。`available_commands_update` 列出扩展命令（`args` → `input.hint`），遮住同名提示模板。
- **列出**：`/help`、交互补全、RPC `get_commands`（`source: "extension"`）。

## 信任

扩展以进程权限运行，必须先被信任才加载。决定按**文件内容的 sha256**（目录扩展为整棵目录树的 sha256） 记在用户级 `trust.json` 的 `extensions` 段：

```json
{
  "version": 1,
  "entries": [],
  "extensions": [
    { "path": "/abs/standup.mjs", "sha256": "…", "trusted": true, "at": "2026-11-15T12:00:00.000Z" }
  ]
}
```

决定顺序：

1. `--no-trust`：全部扩展都不加载。`--trust` 与 profile 的 `trustProject` **不影响**扩展（它们只管项目级资源）。
2. 记录里有同路径且哈希相同的条目：按记录的决定（信任则加载，拒绝则跳过）。
3. 没有记录，或文件内容变了（哈希不符）：
   - 交互 / line 模式：启动时**一次性**列出全部待定文件的路径与 sha256 询问（仅本次 / 信任并记住 / 不信任）；记住的写入 `trust.json`，内容再变就重新询问。
   - 其它模式（`-p`、RPC、ACP）：不加载，写 warning（RPC / `-p` 的 stderr）。要启用，先在交互会话里确认一次。

哈希在加载前计算；加载之间文件被替换的竞争不在防护范围内（本地用户目录已是同一信任域）。

**目录扩展**的哈希覆盖整棵目录树，`trust.json` 记录形状不变（`path` 是目录，`sha256` 是树哈希），目录里任何文件改了都会重新询问，所以多文件扩展应写成目录，而不是只信任入口：

- 参与哈希的是目录下每个常规文件，按「正斜杠相对路径」的字节序排序（与平台、遍历与创建顺序无关），每项依次写入 `<F|L> <路径字节数> <路径> <内容字节数>\n` 与内容字节，前面加固定前缀 `armadra-ext-tree-v1\n`。路径与内容都带长度前缀，不会拼出歧义。
- 任意层级名为 `.git` 的项跳过；符号链接（`L`）按链接目标字符串计入，**不跟随**；socket、fifo 等忽略。`node_modules` 不特殊对待，会计入。
- 上限：最多 2000 个文件、总计 50 MiB。超出时该扩展被跳过，原因是「目录扩展过大」，不会询问也不会加载。
- 交互询问与 `ama doctor` 都会把目录标出来。

单文件扩展照旧：只校验该文件本身，它 `import` 的其它文件不计入哈希；需要多文件时请改用目录扩展，或把依赖打包进单个文件。

## `ama doctor`

`ama doctor` 有「本地扩展」一节：列出每个文件的路径、sha256 前 12 位与状态——**启用**（记录匹配且已信任），或**跳过**及原因（未信任、内容自信任后已改变、已拒绝、读不了文件、目录扩展过大、`--no-trust`）；目录扩展标 `[目录]`，哈希前缀是树哈希。doctor 只读文件与信任记录，**不执行扩展代码**，所以「加载失败 / 版本不等 / `create()` 失败 / 未返回适配器」这类只有加载时才知道的原因不在 doctor 里，它们作为 warning 出现在启动输出里（`-p` 与 RPC 写 stderr，交互模式显示在消息区）。

## 典型用例

| 用例       | 做法                                                                                 |
| ---------- | ------------------------------------------------------------------------------------ |
| 下一步建议 | `events.on("agent_settled")` 后根据最后的回复给出 2–3 条建议，`ui.notify` 显示       |
| 桌面通知   | `agent_settled` 与 `tool_approval_requested` 时向终端写 OSC 777 通知序列             |
| git 检查点 | `turn_start` 时 `git stash create` 记录一个不改工作区的检查点，配合 `/undo` 命令回滚 |
| 自定义命令 | `commands.register({ name: "standup", … })` 汇总今天的会话                           |
| 保温策略   | `cache.onWarmingDecision` 按时段或预算否决空闲保温                                   |

## 不做的事

- **不开放渲染层**：扩展不能替换或插入界面组件、不能接管按键。界面上的表达只有消息区通知、状态栏键值与斜杠命令的输出文本。
- 不做能力声明（信任对话框不按能力展示）、不做命令参数补全、不做扩展之间的依赖顺序（只有文件名排序）。
