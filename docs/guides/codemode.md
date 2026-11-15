# codemode

设计依据见 [design.md](../design/design.md) §5.5、§5.6、§9.1。

`codemode` 工具让模型写一段 JavaScript，在脚本里经 `tools.*` 编排多次工具调用，只有脚本输出回到模型。长流程、工具密集的任务里，它把多次往返合成一次，减少往返次数与缓存读取；短任务里模型照常直接调用工具，codemode 只多占约 400 token 前缀，所以 `default` 预设缺省开着它（脚本总是被隔离，见下文「引擎」）。

## 打开

| 写法                                                             | 模型看到的工具                                                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--tools-preset codemode-only`（`only`；旧名 `codemode` 仍可用） | 只有 `codemode`；全部内置工具与宿主工具只能在脚本里调用，声明列在 `codemode` 描述里                                        |
| `--codemode on` / `codemode.mode: "on"`                          | 预设的工具 + `codemode`；其它工具描述不变，`codemode` 描述一行列出可在脚本里调用的直接工具（参数相同）与仅脚本可调的工具名 |
| `--codemode off` / `codemode.mode: "off"`                        | 不注册 `codemode`                                                                                                          |

`codemode.mode` 不写时**跟随预设**：

| 预设                      | 脚本被隔离（缺省的 `codemode.engine: "auto"` 下总是如此） | `codemode.engine: "node"` 且 Node 22 / 24 没有操作系统沙箱             |
| ------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `default`                 | `on`                                                      | `off`，启动时提示一次（每个配置目录一次，记在数据目录 `notices.json`） |
| `codemode-only`           | `only`                                                    | `only`（`execute` 类，见下）                                           |
| `minimal` / `coordinator` | `off`                                                     | `off`                                                                  |

操作系统沙箱指 macOS 的 `sandbox-exec`、Linux 的 bubblewrap（退而 `unshare -r -n`），见下文沙箱与 [sandbox.md](sandbox.md)；Windows 没有。没有它、Node 也低于 25 时，`auto` 引擎改用 WebAssembly 里的 QuickJS（见下文「引擎」），脚本同样被隔离，所以这些平台也缺省开着 codemode。

缺省配置里不写 `codemode.mode`（`ama init` 生成的 `config.json` 也不写），所以这张映射以后调整时老用户同样生效。`ama config show` / `ama doctor` 显示生效模式与原因（跟随哪个预设、网络由 Node 还是操作系统沙箱隔离）；`ama doctor` 另列操作系统沙箱能力。

`minimal` / `coordinator` 预设缺省不带 codemode，也没有 grep / glob：模型找代码只能用 bash（`default` 权限模式下每次审批、`-p` 下被拒）。要检索就 `tools.default: ["+grep","+glob"]` 直接加上，比为了检索打开 codemode 便宜（见 [design.md](../design/design.md) §5.6）；`codemode-only` 的脚本里 `tools.grep()` / `tools.glob()` / `tools.ls()` 都可调用。

`coordinator` 预设即使显式 `on`，脚本里能调用的工具也只限它的活动集（read 与宿主工具）：`tools.bash`、`tools.write` 在脚本里同样不存在，协调者「不写文件、不跑 bash」的约定不能经 codemode 绕过。

`codemode` 本身的权限类随沙箱能力：脚本被隔离（Node ≥ 25、有操作系统沙箱，或用 QuickJS 引擎，见下文沙箱与引擎）时是 `read` 类，`default` 权限模式下免审批——脚本只能经 `tools.*` 做事，每次内层调用仍逐个经过权限管线；网络未隔离（显式 `codemode.engine: "node"`，且 Node 22 / 24 没有操作系统沙箱）时是 `execute` 类，`default` 模式下每次都要审批，`-p` 等无人值守场景直接拒绝，此时常用做法是在配置里放行它：

```json
{ "version": 1, "tools": { "preset": "codemode-only" }, "permission": { "allow": ["codemode"] } }
```

其它配置：`codemode.inlineBudget`（`only` 模式在描述里内联声明的预算，估算 token，缺省 3000，超出只列名字；`on` 模式不内联）、`codemode.requireStrict`（见下文沙箱）、`codemode.maxHeapMb`（脚本引擎的内存上限，见下文沙箱）、`codemode.maxWorkers`（同时存活的脚本子进程数，见下文「并发」）、`codemode.engine`（`auto` / `node` / `quickjs`，见下文「引擎」；只认用户级）。项目级配置只能把 `codemode.mode` 设为 `off`。

`on` 模式的前缀开销：去重前 `codemode` 描述把已直接暴露的六个工具的声明又内联一遍，其它工具各追加一行提示，系统提示 + 工具表比 `off` 多约 1356 token；现在只多约 390 token（字符 / 4 估算，测试锁定 ≤ 500）。升级后续接的旧会话因为描述字节变化会有一次缓存未命中。

## 脚本

输入是原始 JavaScript（不是 JSON，不要代码块），作为 async 函数体执行，可用顶层 `await` 与 `return`。首行可选：

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
```

- `max_output_tokens`（缺省 10 000，按字符 / 4 估算）：输出超出时保留首尾，全文写 `<会话目录>/outputs/<toolCallId>.txt`（内存会话写系统临时目录）。单条工具结果上限（`tools.maxToolResultChars`，缺省 30 000 字符）更小时以它为准。
- `timeout_ms`（缺省 300 000，上限 3 600 000）：整个脚本的硬期限，到点杀掉子进程树。

| 全局                           | 作用                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `tools.<name>(args)`           | 调用会话里任一未禁用的工具（含宿主注册的 `canvas_*`），走与模型直接调用相同的门禁 |
| `text(v)` / `console.log(...)` | 追加输出；字符串原样，其它值按 JSON（`console.info / warn / error / debug` 相同） |
| `return v`                     | 同 `text(v)`                                                                      |
| `store(key, v)` / `load(key)`  | 跨次保留小块 JSON；`store(key, undefined)` 删除                                   |
| `ALL_TOOLS`                    | 可调用工具名（执行时的清单，含描述冻结之后才注册的宿主工具）                      |
| `describeTool(name)`           | 单个工具的 TypeScript 声明                                                        |
| `searchTools(query, opts?)`    | 在可调用工具里按 BM25（名字 + 描述）排序，见下                                    |
| `image(value)`                 | 把一张图附在脚本结果后面，见下                                                    |

没有 `require`、`import`、`process`、`fetch`、定时器；`eval` 与 `new Function` 被拒绝。工具只能写成 `tools.read({ path })`，不能直接 `read(...)`。

### 给模型的描述

描述首段写明规则（只有 `tools.<name>(args)`；没有 require / import / process / fetch / 定时器；不要把工具当函数直接调用），随后是一段 6 行示例脚本：`Promise.all` 并发两个 `tools.read`、过滤、`return`。实测 Kimi、MiniMax 在旧描述下会在脚本里写 `require` / `import`，或在 `only` 模式下直接调用 `read`。两类错误都给出正确写法：

- 脚本因 `require` / `import` / `process` / `fetch` / 定时器失败：`Script error` 后追加一行 `Only tools.<name>(args) is available in codemode scripts …`；脚本里直接调用工具名（`read is not defined`）：追加 `Call tools as tools.read({...}), not read(...).`
- `only` 模式下系统提示的工具行写明 `codemode` 是唯一工具，规则节加一条「read / edit / bash 等不能直接调用，放进脚本里以 `tools.<name>(args)` 调用」。
- `only` 模式下模型仍绕过 `codemode` 直接调用工具时：错误结果是 `Tool read is only callable inside a codemode script: tools.read({...})`（真不存在的工具仍是 `Tool X not found`）。

### 返回值

- `bash` 解析为 `{ output, truncated, fullOutputPath?, exitCode, wallTimeMs }`，非零退出码同样解析。脚本里的 `output` 放宽到 1 MiB：全文不超过 1 MiB 时就是全文（`truncated` 为假）；更长时保留首尾各 512 KiB，中间是 `[... N bytes omitted; full output: <路径> ...]`，`truncated` 为真，`fullOutputPath` 指向全文文件（可再 `tools.read` 或自己切片）。模型直接调用 bash 的结果不变（2000 行 / 50 KB 尾截断）。脚本最终输出仍按 `max_output_tokens` 截断。
- 其它内置工具解析为文本；宿主 / SDK 工具返回 `structured` 时解析为它，否则为文本。
- 工具失败、被 Hook / 权限 / 用户拒绝、参数非法 → 以 `Error` reject，消息是工具的错误文本；用 `Promise.allSettled` 保留其余结果。
- 同一脚本内最多 8 个调用同时进行，多出的排队；脚本里不能调用 `codemode`。

### searchTools 与 image

- `await searchTools(query, { limit?, namespace? })`：在本次执行可调用的工具里按 BM25（名字 + 描述）排序，解析为 `{ name, description }[]`（描述取首段、≤ 240 字符）；`limit` 缺省 8、上限 50；`namespace` 是工具名前缀（`_` `.` `:` `-` 之前的部分，如 `canvas` 匹配 `canvas_add`）。没有命中为空数组；参数不合法时 reject。它不是工具调用，不过权限也不发事件。工具多、描述里只列了名字时先搜再 `describeTool(name)`。
- `image(value)`：`value` 可以是 base64 的 `data:` URL、`{ image_url }`（字符串或 `{ url }`）、或 `{ type: "image", data, mimeType }`（`tools.read` 读一张图时解析为后者，可直接传入）。只收 PNG / JPEG / GIF / WebP，MIME 由文件头决定（声明的 MIME 被忽略），远程 URL 一律拒绝；不合法时同步抛 `TypeError`。每个脚本最多 8 张，单张受当前端点的上限约束（超限的跳过并在结果里说明）。图片作为图片块附在脚本结果之后，同时存成 `<会话目录>/outputs/<toolCallId>-image-<n>.<扩展名>`（与超长文本同目录），结果文本里写明路径；模型不收图片时协议层会丢掉图片块，路径仍在。

### 结果

`Script completed` / `Script failed` + 用时 + 输出；失败时保留已产生的输出，末尾附 `Script error: …`（带脚本行号）。已完成的工具调用不回滚；脚本结束时仍在跑的调用被取消，未 await 的 Promise 被丢弃。

### store

脚本成功结束且写过 store 时，追加一条 `custom{customType:"ama.codemode-store"}` 条目，内容是完整快照；读取取活动分支上最近一条，所以 `/resume` 后值仍在，切分支、fork 后只看本分支写过的值。单值 JSON ≤ 262 144 字符，合计 ≤ 1 048 576 字符；超限时 `store()` 抛 `RangeError`。失败的脚本不提交。

### 并发

整个 ama 进程（所有会话与子 Agent）同时存活的脚本子进程不超过 2 个；多出的脚本按先来先到排队，最多等 60 s，也不超过脚本自己的 `timeout_ms`（等待计入 `timeout_ms`），到点失败且**没有运行**（错误文本说明名额一直被占）。等待期间被取消立即结束。名额在子进程真正退出时才归还，不是结果落定时。

上限：配置 `codemode.maxWorkers`（正整数，缺省 2，只认用户级）< 环境变量 `AMA_CODEMODE_MAX_WORKERS`（正整数，每次执行时读取，不合法的值被忽略）。

### 脚本被杀之后

脚本每完成一个内层调用就追加一条 `custom{customType:"ama.codemode-call"}`（`{ parent, name, target?, ok }`，不进上下文；`target` 与恢复提醒共用规则：bash 只取命令第一个词，write / edit 取路径，不含参数正文与结果）。进程在脚本跑到一半时被杀，下次 `resume` 的恢复提醒会列出外层 `codemode` 调用没有结果时它已经完成的内层调用（`write src/a.ts: ok`），并要求先核实现场、不要盲目重复。被脚本结束取消的调用不记。

## Hook 与事件

- `codemode` 本身作为一次工具调用经过 PreToolUse、权限与 PostToolUse。
- 脚本里的每次 `tools.*` 再各自经过完整流程，Hook 按**真实工具名**匹配（`bash`，不是 `codemode`）；Hook 输入多两个字段：`viaCodemode: true` 与 `parentToolCallId`（外层 `codemode` 调用的 id）。
- 事件：`tool_execution_update` 透传脚本输出（最近 4000 字符）；内层调用发 `tool_execution_start / end`，带 `parentToolCallId`，不进转录、不进模型上下文。`ama --mode acp` 把每次内层调用单列为一条 `tool_call`（标题前缀 `codemode › `，`_meta.ama.parentToolCallId` 指向外层），其权限请求关联到这条内层调用（见 [acp.md](../reference/acp.md)）。

## 引擎

脚本有两种运行方式，工具描述、全局、结果格式与权限管线完全相同：

| `codemode.engine` | 运行方式                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `node`            | 每次执行起一个 Node 子进程（下文「沙箱」）                                                              |
| `quickjs`         | 每次执行起一个 worker 线程，脚本跑在 WebAssembly 里的 QuickJS（QuickJS-ng）中                           |
| `auto`（缺省）    | 网络已隔离（Node ≥ 25，或有操作系统沙箱）用 `node`，否则（Node 22 / 24 无沙箱，含 Windows）用 `quickjs` |

`ama config show` 与 `ama doctor` 显示生效的引擎与原因（`codemode.engine` 行与 `codemode engine:` 行）。

QuickJS 引擎：

- 零依赖：引擎是随包分发的一个 wasm 文件（`assets/quickjs/`，`ama.cjs` 里内联），用 `WebAssembly` 与 `node:worker_threads` 自己驱动；来源、版本与哈希见该目录的 README。
- 隔离：VM 里没有 `require`、`import`、`process`、`fetch`、定时器、文件与网络；WASI 只给时钟与随机数，stdout / stderr 丢弃；与外界只有一个宿主函数，脚本只能经 `tools.*` 触达外界，所以 `codemode` 是 `read` 类，每次内层调用仍逐个过权限管线。内建对象在脚本运行前冻结（Error 原型除外，子类里 `this.name = …` 要能赋值）；`eval` / `new Function` 留在 VM 内，拿不到宿主。
- 期限：脚本总超时与外层 abort 先写共享的中断标志（空转的 `while (true) {}`、`while (true) await null` 都会被打断），随后 `worker.terminate()`。
- 内存：`codemode.maxHeapMb`（缺省 256 MB，0 不设上限）限制 QuickJS 堆，超出时与 node 引擎同一条脚本错误。
- 栈：QuickJS 在 WASI 上没有栈上限检查，无界递归会让引擎陷阱，脚本以 `Script crashed the QuickJS engine` 失败，宿主不受影响。
- 脚本等待一个永远不会落定的 Promise（没有未完成的工具调用）时立即失败，不拖到超时。
- 与 node 引擎的差异：解释执行，纯计算慢约 6 倍（工具调用主导的脚本几乎没差别）；每次执行启动更快（约 15 ms，对比约 50 ms）；`Date` 用宿主时区；没有 V8 特有的 API（`Error.captureStackTrace` 等）；错误文案按 QuickJS 的写法（如动态 `import()` 报 `could not load module`）。

## 沙箱

每次执行起一个子进程（`node` 引擎）：

```text
<node> --max-old-space-size=256 --permission --allow-fs-read=<ama-sandbox.cjs> --disallow-code-generation-from-strings <ama-sandbox.cjs> --ama-codemode-sandbox
```

- 堆上限：`--max-old-space-size` 取 `codemode.maxHeapMb`（缺省 256 MB，0 不加；只认用户级；`quickjs` 引擎同一个键限制 QuickJS 堆）。脚本超出时子进程 OOM 退出，工具结果是脚本错误 `Script exceeded the codemode memory limit (256 MB); process the data in smaller pieces`，宿主进程内存不受影响；需要一次处理大数据时调大或分片。

- 空环境启动，拿不到密钥、会话文件与环境变量（Windows 上 libuv 会从父进程补入 PATH、SYSTEMROOT、USERPROFILE 等系统变量，不含密钥）；不授予文件写、子进程、worker、addon、inspector 权限；Node 22.0–22.12 用 `--experimental-permission`；嵌入 Electron 时设 `ELECTRON_RUN_AS_NODE=1`。
- 子进程里用 `node:vm` 建只含 ECMAScript 内建对象的上下文（`codeGeneration: { strings: false, wasm: false }`，沙箱对象空原型）；全局函数都在上下文内定义，只经一个宿主函数交换 JSON 字符串；子进程主 realm 也禁止字符串生成代码，经构造器链逃逸拿不到 `Function("return process")`。
- `tools.*` 经 stdin / stdout 的 JSON 行协议回调父进程执行。
- 操作系统沙箱（[sandbox.md](sandbox.md)）：探测到可用的 macOS `sandbox-exec` / Linux `bwrap`（退而 `unshare -r -n`）时，上面整条命令行经它启动，内核拒绝网络（含 DNS）与一切写入。探测是启动时跑一次最小探针（嵌套在别的沙箱里、容器里没有用户命名空间都会失败），结果进程内缓存；`sandbox.enabled: "off"`（只认用户级 / profile）或 `AMA_SANDBOX=off` 关闭。
- 网络：Node ≥ 25 的权限模型同时拒绝网络（strict），操作系统沙箱叠加作纵深防御；Node 22 / 24 的权限模型不管网络，有操作系统沙箱时由它拒绝（strict，子进程必须经它启动，包装不了直接报错）；两者都没有时脚本若逃出 `vm` 就能联网——此时工具描述标注 `network not isolated`、状态栏标 `net!`，`codemode.requireStrict: true` 时直接不注册 `codemode` 并给出 warning（codemode-only 预设随之回退到 default）。

| 实测（`--permission` + 只读入口） | Node 22.19 | Node 24.21 | Node 26.10 |
| --------------------------------- | ---------- | ---------- | ---------- |
| 读其它文件                        | 拒绝       | 拒绝       | 拒绝       |
| 写文件                            | 拒绝       | 拒绝       | 拒绝       |
| 起子进程 / worker                 | 拒绝       | 拒绝       | 拒绝       |
| 联网（fetch / TCP）               | **允许**   | **允许**   | 拒绝       |
| 联网，经 macOS `sandbox-exec`     | 拒绝       | 拒绝       | 拒绝       |

沙箱防的是脚本**绕过权限管线**，不是对抗性的代码执行环境；脚本能造成的副作用都来自它调用的工具，而工具调用照常受 Hook、权限与审批约束。

## 缓存

`codemode` 的描述（含工具声明）在第一次读取时确定并冻结，同一会话内字节稳定；之后宿主注册的工具不改变描述（`only` 模式下也不进活动集），但脚本里可以调用，`ALL_TOOLS` / `describeTool` 能查到。

- 脚本里的内层调用不进转录、不进模型上下文，所以一段脚本无论调用多少次工具，前缀都只多一次 `codemode` 调用与它的结果。
- 一段脚本可能跑几分钟（长测试、批量读写），这正是缓存保温覆盖的场景：保温不区分 codemode，运行期间（`cache.warming: "streaming"`，缺省）在 TTL 到期前重放上一次请求续上缓存，脚本结束后的下一次请求仍按读价计费。保温的前提与经济性见 [providers.md](providers.md)「保温」。
- `/cache fingerprint` 打印最近一次请求的 system / 工具表哈希；开了 codemode 之后哈希在会话内应保持不变。
