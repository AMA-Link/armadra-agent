/**
 * 能力关闭契约（docs/design/design.md §10.0「精简配置」）：每项能力关掉之后，工具表、系统提示的节与规则句、
 * codemode 脚本的 `ALL_TOOLS`、斜杠命令 / RPC `get_commands`、子会话继承的活动集里都**一个不剩**；
 * 并且关闭状态首个请求的 `{ system, tools }` 与黄金逐字节相同（黄金在 `test/fixtures/capability-off/<能力>.json`，= 该能力从未存在时的字节，
 * `UPDATE_GOLDEN=1` 重录并在 PR 说明）。新增能力往 `ROWS` 加一行。
 *
 * 每行开一个「开」与一个「关」会话：开的那个先证明这些面上确实有它（否则「不存在」的断言没有意义）。
 * 为了让脚本清单与子会话也被覆盖，除 codemode 一行外两种状态都打开 codemode（`--codemode on`）与 task。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { buildAnthropicRequest } from "../ai/apis/anthropic-request.js";
import type { FakeResponse } from "../ai/fake/fake-script.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import type { Model, SystemMessage } from "../ai/types.js";
import { TASK_NOTIFICATION_RULE } from "../agents/result.js";
import { REMINDER_CUSTOM_TYPE } from "../agent/reminders.js";
import { runSlashCommand } from "../modes/commands-core.js";
import { handlers, type RpcContext } from "../modes/rpc/commands.js";
import type { Runtime } from "./runtime.js";

let h: ComposeHarness | undefined;
afterEach(() => h?.cleanup());

const anthropic = new ProviderRegistry({ keys: { useEnv: false, userAuthFile: null } }).get(
  "anthropic",
)?.models[0] as Model;
const signal = new AbortController().signal;

type Capability = "memory" | "codemode" | "task" | "todo" | "web_fetch";

interface State {
  argv?: string[];
  /** 用户级 config.json 的补充（与 BASE_CONFIG 浅合并，`tools` 深一层）。 */
  config?: { tools?: Record<string, unknown>; codemode?: Record<string, unknown> };
}

interface Row {
  name: Capability;
  on: State;
  off: State;
  /** 关闭后不得出现在工具表、`ALL_TOOLS`、子会话活动集里的工具名。 */
  tools: string[];
  /** 关闭后不得出现在系统提示里的文本（规则句、节标记）。 */
  text?: string[];
  /** 关闭后整个前缀（系统提示 + 全部工具描述与 schema，含 codemode 的工具清单）里不得出现的词。 */
  words: string[];
  /** 关闭后不得出现的系统提示节。 */
  sections?: string[];
  /** 关闭后 `/help` 与 `get_commands` 里不得出现的命令。 */
  commands?: string[];
  /** 是否检查脚本清单（codemode 一行关掉的就是 codemode 本身，跳过）。 */
  script: boolean;
  /** 是否检查子会话活动集（task 一行关掉的就是子会话入口，跳过）。 */
  child: boolean;
}

const MARK = "CAPABILITY-CHILD";
/** 开 codemode（Node 24 下属 execute，需要 allow）与 task，作为两种状态的共同底座。 */
const BASE_CONFIG = {
  version: 1,
  permission: { allow: ["codemode", "task"] },
  tools: { default: ["+task"] },
};

const ROWS: Row[] = [
  {
    name: "memory",
    words: ["memory"],
    on: { argv: ["--memory", "--trust"] },
    off: {},
    tools: ["memory"],
    text: ['<scope name=\\"user\\">'],
    sections: ["memory"],
    commands: ["memory"],
    script: true,
    child: true,
  },
  {
    name: "codemode",
    words: ["codemode"],
    on: { argv: ["--codemode", "on"] },
    off: { argv: ["--codemode", "off"] },
    tools: ["codemode"],
    text: ["codemode:"],
    script: false,
    child: true,
  },
  {
    name: "task",
    words: ["task_ctl", "<task-notification>"],
    on: {},
    off: { config: { tools: { default: [], disabled: ["task"] } } },
    tools: ["task", "task_ctl"],
    text: [TASK_NOTIFICATION_RULE, "task:"],
    commands: ["tasks"],
    script: true,
    child: false,
  },
  {
    name: "todo",
    words: ["todo"],
    on: { config: { tools: { default: ["+task", "+todo"] } } },
    off: { config: { tools: { default: ["+task"], disabled: ["todo"] } } },
    tools: ["todo"],
    text: ["todo:"],
    script: true,
    child: true,
  },
  {
    name: "web_fetch",
    words: ["web_fetch"],
    on: {},
    off: { config: { tools: { default: ["+task"], disabled: ["web_fetch"] } } },
    tools: ["web_fetch"],
    text: ["web_fetch"],
    script: true,
    child: true,
  },
];

/** 一次会话：codemode 脚本返回 ALL_TOOLS、开一个子会话、收尾。 */
function script(row: Row, state: "on" | "off"): FakeResponse[] {
  const out: FakeResponse[] = [];
  const codemode = row.name !== "codemode" || state === "on";
  const task = row.name !== "task" || state === "on";
  if (codemode)
    out.push({
      steps: [
        { toolCall: { name: "codemode", arguments: { script: 'return ALL_TOOLS.join(",")' } } },
      ],
    });
  if (task)
    out.push(
      {
        steps: [
          {
            toolCall: {
              name: "task",
              arguments: { prompt: `${MARK} say hi`, description: "probe", background: false },
            },
          },
        ],
      },
      { text: "child done" },
    );
  out.push({ text: "done" });
  return out;
}

interface Observed {
  runtime: Runtime;
  tools: string[];
  sections: string[];
  system: string;
  prefix: string;
  commands: string[];
  help: string;
  allTools: string[] | undefined;
  childTools: string[] | undefined;
}

function configFor(state: State): Record<string, unknown> {
  const extra = state.config ?? {};
  return {
    ...BASE_CONFIG,
    ...extra,
    tools: { ...BASE_CONFIG.tools, ...(extra.tools ?? {}) },
  };
}

async function observe(row: Row, which: "on" | "off"): Promise<Observed> {
  const state = row[which];
  h = composeHarness(script(row, which));
  h.home.write("home/.config/ama/config.json", configFor(state));
  const argv = ["--model", "fake/echo", "-p", "x", ...(state.argv ?? [])];
  if (row.name !== "codemode" && !argv.includes("--codemode")) argv.push("--codemode", "on");
  const runtime = await h.boot(argv);
  await runtime.session.prompt("go");
  const first = h.fake.calls[0]!.context;
  const body = buildAnthropicRequest(anthropic, first, { signal, cacheRetention: "short" }).body;
  const root = h.home.root;
  const normalize = (json: string): string =>
    json
      .split(JSON.stringify(root).slice(1, -1))
      .join("<root>")
      .replace(/<root>[^\s"]*/g, (path) => path.replace(/\\\\/g, "/"));
  const prefix = normalize(
    JSON.stringify({ system: body["system"], tools: body["tools"] }, (key, value: unknown) =>
      key === "cache_control" ? undefined : value,
    ),
  );
  const systemMessage = runtime.session.entries.flatMap((e) =>
    e.type === "message" && e.message.role === "system" ? [e.message as SystemMessage] : [],
  )[0]!;
  const results = runtime.session.messages.filter((m) => m.role === "toolResult");
  const codemodeResult = results.find((m) => m.toolName === "codemode");
  const allTools =
    codemodeResult === undefined
      ? undefined
      : (/^([a-z_,]+)$/m.exec(String(codemodeResult.content))?.[1]?.split(",") ?? []);
  const child = h.fake.calls.find((c) =>
    c.context.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes(MARK)),
  );
  const toolNames = (b: Record<string, unknown>): string[] =>
    ((b["tools"] as { name: string }[] | undefined) ?? []).map((t) => t.name);
  const childBody =
    child === undefined
      ? undefined
      : buildAnthropicRequest(anthropic, child.context, { signal, cacheRetention: "short" }).body;
  const ctx = { runtime, session: () => runtime.session } as unknown as RpcContext;
  const listed = (await handlers.get_commands({} as never, ctx)) as {
    commands: { name: string }[];
  };
  const help = await runSlashCommand("/help", {
    runtime,
    session: () => runtime.session,
    switchSession: async () => runtime.session,
  });
  return {
    runtime,
    tools: toolNames(body),
    sections: Object.entries(systemMessage.sections)
      .filter((e) => e[1] !== null)
      .map((e) => e[0]),
    system: JSON.stringify(body["system"]),
    prefix,
    commands: listed.commands.map((c) => c.name),
    help: help?.kind === "handled" ? (help.message ?? "") : "",
    allTools,
    childTools: childBody === undefined ? undefined : toolNames(childBody),
  };
}

function golden(name: Capability, actual: string): void {
  const file = new URL(`../../test/fixtures/capability-off/${name}.json`, import.meta.url);
  if (process.env["UPDATE_GOLDEN"] === "1") writeFileSync(file, `${actual}\n`);
  expect(existsSync(file), `missing golden ${file.pathname}; record with UPDATE_GOLDEN=1`).toBe(
    true,
  );
  expect(actual).toBe(readFileSync(file, "utf8").trimEnd());
}

describe("能力关闭契约", () => {
  for (const row of ROWS) {
    it(`${row.name}：开时各面都有它，关后一个不剩，关闭态前缀与黄金逐字节相同`, async () => {
      const on = await observe(row, "on");
      for (const tool of row.tools) {
        expect(on.tools, `on/tools ${tool}`).toContain(tool);
        if (row.script) expect(on.allTools, `on/ALL_TOOLS ${tool}`).toContain(tool);
        if (row.child && tool !== "task_ctl")
          expect(on.childTools, `on/child ${tool}`).toContain(tool);
      }
      for (const text of row.text ?? []) expect(on.system, `on/system ${text}`).toContain(text);
      for (const word of row.words) expect(on.prefix, `on/prefix ${word}`).toContain(word);
      for (const section of row.sections ?? []) expect(on.sections).toContain(section);
      for (const command of row.commands ?? []) {
        expect(on.commands).toContain(command);
        expect(on.help).toContain(`/${command} `);
      }
      await on.runtime.dispose();
      h?.cleanup();

      const off = await observe(row, "off");
      for (const tool of row.tools) {
        expect(off.tools, `off/tools ${tool}`).not.toContain(tool);
        if (row.script) {
          expect(off.allTools, "off/ALL_TOOLS ran").toBeDefined();
          expect(off.allTools, `off/ALL_TOOLS ${tool}`).not.toContain(tool);
        }
        if (row.child) {
          expect(off.childTools, "off/child ran").toBeDefined();
          expect(off.childTools, `off/child ${tool}`).not.toContain(tool);
        }
      }
      for (const text of row.text ?? [])
        expect(off.system, `off/system ${text}`).not.toContain(text);
      for (const section of row.sections ?? []) expect(off.sections).not.toContain(section);
      for (const word of row.words) expect(off.prefix, `off/prefix ${word}`).not.toContain(word);
      for (const command of row.commands ?? []) {
        expect(off.commands).not.toContain(command);
        expect(off.help).not.toContain(`/${command} `);
      }
      golden(row.name, off.prefix);
      await off.runtime.dispose();
    });
  }

  it("todo：关闭时即使脚本建了清单，连续多回合也不出现 todo 复述；开启时出现", async () => {
    const turns = 11;
    const run = async (active: boolean): Promise<string[]> => {
      const setTodo = {
        action: "set",
        items: [{ id: "1", text: "step one", status: "pending" }],
      };
      const first: FakeResponse = active
        ? { steps: [{ toolCall: { name: "todo", arguments: setTodo } }] }
        : {
            steps: [
              {
                toolCall: {
                  name: "codemode",
                  arguments: { script: `return tools.todo(${JSON.stringify(setTodo)})` },
                },
              },
            ],
          };
      h = composeHarness([first, ...Array.from({ length: turns + 2 }, () => ({ text: "ok" }))]);
      h.home.write(
        "home/.config/ama/config.json",
        configFor({ config: { tools: { default: active ? ["+todo"] : [] } } }),
      );
      const runtime = await h.boot(["--model", "fake/echo", "-p", "x", "--codemode", "on"]);
      for (let i = 0; i <= turns; i++) await runtime.session.prompt(`turn ${i}`);
      const reminders = runtime.session.entries.flatMap((e) =>
        e.type === "custom_message" && e.customType === REMINDER_CUSTOM_TYPE
          ? [JSON.stringify(e.content)]
          : [],
      );
      expect(
        runtime.session.entries.some((e) => e.type === "custom" && e.customType === "ama.todo"),
        "todo list was written",
      ).toBe(true);
      await runtime.dispose();
      h.cleanup();
      return reminders;
    };
    expect((await run(true)).some((r) => r.includes("The todo list has not been updated"))).toBe(
      true,
    );
    expect((await run(false)).some((r) => r.includes("todo"))).toBe(false);
  });
});
