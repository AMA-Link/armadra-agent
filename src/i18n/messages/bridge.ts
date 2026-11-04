/**
 * 消息目录：bridge（`ama --mode acp --bridge pi`，键名规范见 docs/guides/i18n.md）。[#254]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`。桥只翻译给人看的文案（ACP 错误信息、stderr 诊断、
 * 配置项名称）；`_meta`、id、value 等机器字段与发给 Pi 的一切固定英文，不走这里。
 */

import type { Messages } from "../types.js";

export const en = {
  /** 命令行用法错误。 */
  args: {
    unknownOption: (option: string) => `--bridge pi: unknown option ${option}`,
    needsValue: (option: string) => `${option} needs a value`,
    unsupportedBridge: (value: string) => `--bridge only supports pi (got ${value})`,
    needsAcpMode: "--bridge pi requires --mode acp",
    ownedFlag: (flag: string) =>
      `${flag} is managed by the bridge and cannot be passed through to pi after --`,
  },
  /** Pi 的探测与版本。 */
  pi: {
    missing: (pkg: string) =>
      `pi is not installed or not on PATH; install it with: npm i -g ${pkg}`,
    outdated: (installed: string, minimum: string, pkg: string) =>
      `pi ${installed} is older than the minimum ${minimum}; update it with: npm i -g ${pkg}`,
    unverified: (version: string, range: string) =>
      `pi ${version} is outside the verified range ${range}; running with the newest known capabilities`,
    versionUnknown: (range: string) =>
      `could not read the pi version (verified range ${range}); running with the newest known capabilities`,
    noModel:
      "pi has no usable model; sign in with /login in pi (or configure a model), then try again",
    startFailed: (error: string) => `pi failed to start (${error})`,
    exited: (hint: string) => `pi exited${hint === "" ? "" : `: ${hint}`}`,
    promptRejected: (error: string) => `pi rejected the prompt: ${error}`,
    turnFailed: (error: string) => `pi turn failed: ${error}`,
    commandTimedOut: (command: string) => `pi did not answer ${command} in time`,
    cancelGraceExpired: "pi did not stop within the grace period after cancel; closing the process",
  },
  /** ACP 会话。 */
  session: {
    notFound: (id: string) => `session ${id} not found in pi`,
    notOpen: (id: string) =>
      `session ${id} is not open in this connection; send session/load or session/resume first`,
    busy: "a prompt is already running in this session",
    invalidCwd: (cwd: string) => `cwd must be an absolute path (got ${cwd})`,
    missingParam: (key: string) => `missing ${key}`,
    promptNotArray: "prompt must be an array of content blocks",
  },
  /** 配置项（给人看的名称）。 */
  config: {
    model: "Model",
    thoughtLevel: "Thinking level",
    unknownOption: (id: string) => `unknown config option: ${id}`,
    invalidValue: (id: string, value: string) => `invalid value for config option ${id}: ${value}`,
    setFailed: (id: string, error: string) => `pi could not change ${id}: ${error}`,
    levels: {
      off: "Off",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
      max: "Max",
    },
  },
};

export const zh = {
  args: {
    unknownOption: (option) => `--bridge pi：未知选项 ${option}`,
    needsValue: (option) => `${option} 需要一个值`,
    unsupportedBridge: (value) => `--bridge 只支持 pi（收到 ${value}）`,
    needsAcpMode: "--bridge pi 需要配合 --mode acp",
    ownedFlag: (flag) => `${flag} 由桥自己管理，不能经 -- 之后透传给 pi`,
  },
  pi: {
    missing: (pkg) => `没有找到 pi（未安装或不在 PATH 里）；用 npm i -g ${pkg} 安装`,
    outdated: (installed, minimum, pkg) =>
      `pi ${installed} 低于最低版本 ${minimum}；用 npm i -g ${pkg} 更新`,
    unverified: (version, range) => `pi ${version} 超出已验证区间 ${range}；按已知的最新能力运行`,
    versionUnknown: (range) => `读不出 pi 的版本（已验证区间 ${range}）；按已知的最新能力运行`,
    noModel: "pi 没有可用模型；请在 pi 里用 /login 登录（或配置模型）后再试",
    startFailed: (error) => `pi 启动失败（${error}）`,
    exited: (hint) => `pi 已退出${hint === "" ? "" : `：${hint}`}`,
    promptRejected: (error) => `pi 拒绝了这条提示：${error}`,
    turnFailed: (error) => `pi 这一轮出错：${error}`,
    commandTimedOut: (command) => `pi 没有及时回应 ${command}`,
    cancelGraceExpired: "取消后 pi 没有在宽限期内停下；关闭进程",
  },
  session: {
    notFound: (id) => `pi 里没有会话 ${id}`,
    notOpen: (id) => `会话 ${id} 没有在本连接中打开；先发 session/load 或 session/resume`,
    busy: "这个会话里已有提示在运行",
    invalidCwd: (cwd) => `cwd 必须是绝对路径（收到 ${cwd}）`,
    missingParam: (key) => `缺少 ${key}`,
    promptNotArray: "prompt 应为内容块数组",
  },
  config: {
    model: "模型",
    thoughtLevel: "思考级别",
    unknownOption: (id) => `未知配置项：${id}`,
    invalidValue: (id, value) => `配置项 ${id} 的值无效：${value}`,
    setFailed: (id, error) => `pi 无法修改 ${id}：${error}`,
    levels: {
      off: "关",
      minimal: "最低",
      low: "低",
      medium: "中",
      high: "高",
      xhigh: "超高",
      max: "最大",
    },
  },
} satisfies Messages<typeof en>;
