# 命令式 Hook（hooks.json）

命令式 Hook 是在固定时机运行的 shell 命令：ama 把事件写成 JSON 交给命令的 stdin，按退出码与 stdout JSON 决定放行、阻止或改写。它是**用户策略**层——可以改工具输入、一票否决工具调用、给提示追加上下文、让运行再跑一轮。类型定义在 `src/hooks/types.ts`（经 `@armadra/agent` 导出 `HookInput`、`HookOutput`、`HookConfig` 等）。设计依据见 [design.md](../design/design.md) §6.1、§6.3、§7.3。

## 配置

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "hooks": [{ "type": "command", "command": "./scripts/guard.sh", "timeoutMs": 10000 }]
      },
      { "matcher": "write|edit", "hooks": [{ "type": "command", "command": "ama-fmt-check" }] }
    ],
    "PostToolUse": [
      {
        "matcher": "edit",
        "hooks": [{ "type": "command", "command": "prettier --check \"$AMA_FILE\"" }]
      }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "./scripts/inject-context.sh" }] }
    ]
  }
}
```

| 位置                       | 来源      | 说明                                                            |
| -------------------------- | --------- | --------------------------------------------------------------- |
| `~/.config/ama/hooks.json` | `user`    | 用户级（`AMA_CONFIG_DIR` 可改配置目录）                         |
| profile 的 `hooksFile`     | `profile` | 宿主（如 Armadra）提供，视同用户级                              |
| `<cwd>/.ama/hooks.json`    | `project` | 项目级，**需要信任**；未信任时跳过，`ama doctor` 与启动画面提示 |

三份按「用户 → profile → 项目」**拼接**各事件的数组，不覆盖。文件语法或字段错误（含非法 matcher）→ 启动失败，退出码 3。`config.json` 的 `hooks.timeoutMs` 设缺省超时（缺省 60 000 ms），单条命令的 `timeoutMs` 优先，上限 600 000 ms。`/hooks` 与 `ama doctor` 列出已加载的 Hook 及来源。SDK 的 `createAgentSession({ hooks })` 直接传 `HookConfig`，缺省不读文件系统里的 hooks.json。

## 事件

| 事件               | 时机                                                                      | stdout JSON 可改变什么                                                                                                    | 退出码 2                            |
| ------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `SessionStart`     | 会话创建 / 恢复后、首次提示前（`source`）                                 | `additionalContext` → 系统提示的 `hooks` 节；`decision: "block"` → 启动失败                                               | 启动失败，退出码 6（换会话时忽略）  |
| `UserPromptSubmit` | 用户提示展开后、入转录前                                                  | `decision: "block"` + `reason` 阻止本次提示；`updatedPrompt` 替换提示；`additionalContext` 作为 custom 消息随提示进上下文 | 阻止，reason 显示给用户             |
| `PreToolUse`       | schema 校验之后、权限管线之前                                             | `decision: "allow" \| "deny" \| "ask"`、`reason`、`updatedInput` 替换工具输入                                             | deny，stderr 作为 reason 进工具结果 |
| `PostToolUse`      | 工具执行后、结果入转录前                                                  | `additionalContext` 追加到工具结果末尾；`decision: "block"` 把结果改为错误                                                | 结果标为错误，stderr 追加进结果     |
| `Stop`             | 运行将要结束（`agent_before_settle`，没有排队的 followUp）                | `decision: "block"` + `reason` → 以 reason 作为新的 user 消息**再跑一轮**（每次运行最多 3 次）                            | 同左                                |
| `SubagentStop`     | `task` 子会话将要结束                                                     | 同 Stop，作用于子会话                                                                                                     | 同左                                |
| `PreCompact`       | 档二摘要压缩前                                                            | `customInstructions` 追加到摘要提示；`decision: "block"` 取消本次压缩                                                     | 取消压缩                            |
| `Notification`     | 需要用户注意：审批等待、运行结束、错误、重试                              | 无（纯通知）                                                                                                              | 忽略                                |
| `SessionEnd`       | 退出或换会话前（`reason: exit \| new \| switch`）                         | 无                                                                                                                        | 忽略                                |
| `PostRewind`       | 回滚完成后（`/rewind`、RPC `rewind`、SDK `session.rewind()`；预览不触发） | 无（纯通知，不可阻止）                                                                                                    | 忽略                                |
| `PostCompact`      | 档二摘要压缩写入之后（自动与手动；失败或取消不触发）                      | `additionalContext` 作为 custom 消息（`ama.hook_context`）追加在上下文末尾；不可阻止                                      | 忽略                                |

每个事件只接受上表的决策；`deny` 与 `block` 在两类事件间互换（`UserPromptSubmit` 返回 `deny` 视为 `block`，`PreToolUse` 返回 `block` 视为 `deny`），其它不接受的决策忽略并记 warning。

**范围**：

- `task` 子会话（`depth: 1`）以自己的 `sessionId` / `sessionFile` 跑 Hook：它内部的每次工具调用照常触发 PreToolUse / PostToolUse，将要结束时触发 `SubagentStop`（不是 `Stop`）；它**不触发** `SessionStart` / `SessionEnd`——子会话的开始与结束由父会话的 `PreToolUse(task)` 与子会话的 `SubagentStop` 表达。
- 外部 Agent（`task(agent="claude")` 等）内部的工具调用在外部 CLI 自己的策略下运行，**不经 ama 的 Hook**；ama 这边只有父会话的 `PreToolUse(task)` / `PostToolUse(task)`，外部 Agent 也不触发 `SubagentStop`。
- codemode 脚本里的每次内层调用逐个触发（见下文「输入」的 codemode 段）。

任何事件的 stdout 都可以带 `"continue": false`：请求结束当前运行（reason 显示给用户）。`"suppressOutput": true` 被接受并合并，但当前界面本来就不显示 Hook 的 stdout，暂无可见效果。

## 输入（stdin）

stdin 是一个 JSON 对象，写完即关闭。所有事件共有：

| 字段             | 说明                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| `hookEventName`  | 事件名                                                                |
| `sessionId`      | 会话 id（子会话为子会话自己的）                                       |
| `sessionFile`    | 会话文件（落盘前缺省）                                                |
| `cwd`            | 会话 cwd                                                              |
| `model`          | `{ provider, id }`                                                    |
| `permissionMode` | `plan` / `allowlist` / `default` / `auto-edit` / `auto` / `full-auto` |
| `depth`          | 主会话 0，`task` 子会话 1                                             |
| `host`           | 宿主适配器 id（激活时）                                               |

事件特有：

| 事件                    | 字段                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SessionStart`          | `source: startup \| resume \| new \| fork`                                                                       |
| `SessionEnd`            | `reason: exit \| new \| switch`                                                                                  |
| `UserPromptSubmit`      | `prompt`                                                                                                         |
| `PreToolUse`            | `toolCallId`、`toolName`、`toolInput`、`viaCodemode?`、`parentToolCallId?`                                       |
| `PostToolUse`           | 同上 + `toolResult: { content, isError }`（content 为文本）                                                      |
| `Stop` / `SubagentStop` | `lastAssistantText`、`stopHookActive`（本次运行已被 Stop Hook 续跑过；处理器应避免再 block 造成循环）            |
| `PreCompact`            | `tokensBefore`、`trigger: auto \| manual`                                                                        |
| `PostCompact`           | `tokensBefore`、`tokensAfter`（压缩后估算，含摘要与回注块）、`trigger: auto \| manual`                           |
| `Notification`          | `notification: { kind: approval \| settled \| error \| retry, message }`                                         |
| `PostRewind`            | `entryId`（回滚到的用户消息）、`mode: both \| conversation \| code`、`files`（被恢复或删除的文件，仅对话时为空） |

**codemode**：脚本里经 `tools.*` 发起的每次调用都单独经过 PreToolUse / PostToolUse，matcher 按**真实工具名**匹配（`bash`，不是 `codemode`），输入多两个字段：`viaCodemode: true` 与 `parentToolCallId`（外层 `codemode` 调用的 id）。`codemode` 调用本身也作为一次工具调用经过两个事件。模型直接发起的调用不带这两个字段。

环境变量（便于 shell 脚本）：`AMA_HOOK_EVENT`、`AMA_SESSION_ID`、`AMA_CWD`，工具事件另有 `AMA_TOOL_NAME`，`read` / `write` / `edit` 另有 `AMA_FILE`（目标路径）。

## 输出（退出码与 stdout）

| 退出码                | 含义                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `0`                   | 放行；stdout 若是 JSON 对象则解析（空或非 JSON = 无决策）                |
| `2`                   | 阻止：按上表「退出码 2」列处理，stderr 文本作为 reason；stdout 不再解析  |
| 其它非零 / 被信号杀死 | Hook 自身错误，**不阻塞**：记 warning（附 stderr 末 3 行），按无决策继续 |
| 超时                  | 同非阻塞错误；**但 PreToolUse 超时按 deny**（fail-safe）                 |

stdout JSON：

```ts
interface HookOutput {
  decision?: "allow" | "deny" | "ask" | "block";
  reason?: string;
  updatedInput?: unknown; // PreToolUse
  updatedPrompt?: string; // UserPromptSubmit
  additionalContext?: string; // SessionStart / UserPromptSubmit / PostToolUse / PostCompact
  customInstructions?: string; // PreCompact
  continue?: false; // 任何事件：结束当前运行
  suppressOutput?: true;
}
```

字段类型不对的丢弃并记 warning。stdout / stderr 各最多收集 1 MiB。

## 合并与顺序

同一事件下所有匹配的 Hook **并行**启动，全部结束后按配置顺序合并：

- 决策取最严：`deny > block > ask > allow`；reason 取决定性那条 Hook 的。
- `updatedInput` / `updatedPrompt` 只在**恰好一个** Hook 返回时采用；多个则全部忽略并 warning。
- `additionalContext` / `customInstructions` 按配置顺序拼接。
- 任一 Hook 返回 `continue: false` 即请求结束运行。

一次工具调用的完整顺序（[design.md](../design/design.md) §6.3）：

```text
模型产出工具调用
  1. schema 校验（失败 → 错误结果，不再往下）
  2. PreToolUse Hook（并行，合并为 allow / ask / deny / 无；updatedInput 替换输入）
  3. 权限管线：① deny 规则或 Hook deny → deny
               ② 危险命令识别（bash）→ ask（无人值守时 deny）
               ③ 权限模式决定 ask / allow
               ④ allow 规则或 Hook allow 把 ③ 的 ask 变 allow（不能越过 ①②）；Hook ask 把 allow 变 ask
  4. 结果为 ask → 审批链：宿主 broker → 界面对话框 / RPC 客户端 → 无人作答 deny；超时 10 分钟 deny
  5. 执行工具
  6. PostToolUse Hook（追加上下文 / 改为错误）→ 结果入转录
```

Hook 在权限管线之前，是因为它是用户策略（可以改输入、可以否决）；Hook 的 allow 只能免去模式带来的审批，不能放宽 deny 规则与危险命令识别。

## matcher

只对 `PreToolUse` / `PostToolUse` 生效，其它事件忽略 matcher。

| 写法                            | 匹配                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 缺省、`""`、`*`                 | 全部工具                                                                                                                    |
| `bash`                          | 精确匹配工具名                                                                                                              |
| `write\|edit`                   | 多选（括号外的 `\|` 分隔）                                                                                                  |
| `canvas_*`                      | glob：`*` 任意字符串、`?` 单个字符                                                                                          |
| `bash(git push*)`               | 先匹配工具名，再对参数文本做 glob：bash 是 `command`，文件类工具是 `path`，其它工具是输入的 JSON 文本                       |
| `web_fetch(*docs.example.org*)` | `web_fetch` 的参数文本是整个 `url`（含协议与查询串，`*` 跨 `/`）；与权限规则 `web_fetch(<pattern>)` 的 `host/path` 语义不同 |
| `/regex/flags`                  | 对工具名做正则                                                                                                              |

## 运行环境

- POSIX：`/bin/sh -c <command>`，独立进程组；超时或运行被中断时向整组发 SIGTERM，1 秒后 SIGKILL。
- Windows：Git Bash（`AMA_HOOK_SHELL` 指定，或常见安装位置）；找不到时 `cmd /d /s /c`。
- cwd 为会话 cwd；Hook 以 ama 进程的权限运行，继承环境变量。

## 信任

- 用户级与 profile 的 Hook 总是加载。项目级 `.ama/hooks.json`（与 `.ama/skills/`、`.ama/prompts/`、祖先 `.agents/skills/`）在目录被**信任**之前不加载。
- 信任的粒度是目录（含子目录），记在 `~/.config/ama/trust.json`。决策顺序：`--trust` / `--no-trust` → `trust.json` 里最近祖先的记录 → 交互模式询问一次（可记住）→ 非交互模式缺省不信任。宿主 profile 可设 `trustProject: true`。
- 信任一个仓库 = 允许它的 Hook 以你的身份执行命令。信任不会放开权限：项目级 `config.json` 仍只能收紧规则。

## 事件观察

每条 Hook 结束后发 `hook_executed{event, command, exitCode, durationMs}`（RPC 事件与宿主事件都有），超时或被信号杀死时 `exitCode` 为 null。

## 按能力接入

各项能力都用上面的事件接入，没有专门的事件。下表是对应关系，再往下是一份把各行放在一起的 hooks.json。

| 能力                  | 事件与 matcher                                                                                                               | 能做什么                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `web_fetch`           | `PreToolUse` / `PostToolUse`，matcher `web_fetch` 或 `web_fetch(*docs.example.org*)`（括号内对 `toolInput.url` 文本做 glob） | PreToolUse 拒绝、改为询问或用 `updatedInput` 改 URL；PostToolUse 用 `additionalContext` 给抓回的正文加备注，`decision: "block"` 整页拒收 |
| 子 Agent 开始         | `PreToolUse`，matcher `task`；按类型筛用 `task(*"agent":"explore"*)`（括号内是输入的 JSON 文本）                             | 输入含 `agent`、`prompt`、`model`、`background`：可以 deny，也可以用 `updatedInput` 改 prompt 或换 agent                                 |
| 子 Agent 结束         | `SubagentStop`（输入带 `lastAssistantText`）                                                                                 | `decision: "block"` + `reason`（或退出码 2）让子会话带着 reason 再跑一轮                                                                 |
| 子 Agent 内部的调用   | 照常的 `PreToolUse` / `PostToolUse`，输入 `depth: 1`                                                                         | 与主会话相同；脚本按 `depth` 区分主会话与子会话                                                                                          |
| 后台任务完成          | `SubagentStop`（后台的 ama 子会话结束时同样触发）                                                                            | 桌面通知、记日志；没有单独的「后台任务完成」通知种类                                                                                     |
| 外部 Agent            | `PreToolUse` / `PostToolUse`，matcher `task(*"agent":"claude"*)`                                                             | 拦截或改写委派本身；外部 Agent 内部的调用不经 Hook（见「范围」）                                                                         |
| codemode 编排子 Agent | 脚本里每个 `tools.task(...)` 都是一对 `PreToolUse(task)` / `PostToolUse(task)`，输入带 `viaCodemode` 与 `parentToolCallId`   | 与模型直接调用 `task` 相同；按 `parentToolCallId` 把同一个脚本发起的任务归到一起                                                         |

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "web_fetch",
        "hooks": [{ "type": "command", "command": "./.ama/fetch-guard.sh" }]
      },
      {
        "matcher": "task(*\"agent\":\"claude\"*)",
        "hooks": [{ "type": "command", "command": "./.ama/log-delegation.sh" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "web_fetch(*docs.example.org*)",
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"additionalContext\":\"docs.example.org 的页面对应最新版本，旧版本另查\"}'"
          }
        ]
      }
    ],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "./.ama/subagent-tests.sh" }] }]
  }
}
```

`web_fetch` 行随 `web_fetch` 工具一起提供（matcher 括号内取 `url` 的改动在同一批里）。它的 matcher 只认 URL 文本上的 `*` / `?` glob；权限规则 `web_fetch(<glob>)` 是另一套写法（对 `host/path` 匹配，裸域名含子域），见 [permissions.md](permissions.md)。只想放行少数站点时优先用权限规则或 `allowlist` 模式，Hook 适合需要脚本判断的情形。

只允许抓取文档站（`.ama/fetch-guard.sh`，配在上面的 `PreToolUse` `web_fetch` 下）：

```sh
#!/bin/sh
url=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).toolInput.url))')
case "$url" in
  https://docs.example.org/*|https://registry.npmjs.org/*) exit 0 ;;
esac
echo "只允许抓取文档站：$url" >&2
exit 2
```

子任务结束时跑测试，失败就让它接着修（`.ama/subagent-tests.sh`，配在 `SubagentStop` 下）：

```sh
#!/bin/sh
input=$(cat)
# 已经被本 Hook 续跑过一次：放行，避免循环
case "$input" in *'"stopHookActive":true'*) exit 0 ;; esac
out=$(npm test --silent 2>&1) && exit 0
echo "Tests failed; fix them before reporting back:" >&2
printf '%s\n' "$out" | tail -n 20 >&2
exit 2
```

## 示例

阻止推送到 main：

```sh
#!/bin/sh
# .ama/guard.sh；hooks.json：{"matcher":"bash(git push*)","hooks":[{"type":"command","command":"./.ama/guard.sh"}]}
input=$(cat)
case "$input" in
  *'main'*) echo "不要直接推送 main，请开分支" >&2; exit 2 ;;
esac
exit 0
```

编辑后跑格式检查，把结果交给模型：

```json
{
  "matcher": "edit|write",
  "hooks": [
    {
      "type": "command",
      "command": "prettier --check \"$AMA_FILE\" >/dev/null 2>&1 || echo '{\"additionalContext\":\"prettier 检查失败，请修正格式\"}'"
    }
  ]
}
```
