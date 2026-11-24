/**
 * `/workflow` 命令：子命令、`name=value` 解析、预览取消、gate 与验证升级、save 无任务、交给宿主。[#318]
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionImpl } from "../agent/session.js";
import type { Runtime } from "../cli/runtime.js";
import { setLocale } from "../i18n/index.js";
import type { SubagentRequest, SubagentResult } from "../tools/types.js";
import { AgentEventBus, createHostApi, createHostContext } from "../host/api-impl.js";
import { runSlashCommand, type CommandContext, type CommandResult } from "./commands-core.js";
import type { ChooseSpec } from "./interactive/workflow-gate.js";
import { workflowPrompts, lineChooser } from "./interactive/workflow-gate.js";
import { parseParams, tokenize, type WorkflowUi } from "./workflow-command.js";

let mockRegistry: unknown;
vi.mock("../agent/subagent-registry.js", async (orig) => {
  const real = await orig<typeof import("../agent/subagent-registry.js")>();
  return {
    ...real,
    registryOf: (id: string) => mockRegistry ?? real.registryOf(id),
  };
});

beforeAll(() => setLocale("en"));
afterAll(() => setLocale("zh"));

let dir: string;
let counter = 0;
beforeEach(() => {
  mockRegistry = undefined;
  dir = mkdtempSync(join(tmpdir(), "ama-wfcmd-"));
  mkdirSync(join(dir, ".ama", "workflows"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FILE = (extra = "", steps = ""): string => `---
version: 2
title: Demo flow
params:
  - name: topic
roles:
  - id: a
    agentId: ama
steps:
  - id: first
    kind: prompt
    role: a
    prompt: "Write about {{topic}}"
${steps}${extra}---
`;
const put = (id: string, text: string): void =>
  writeFileSync(join(dir, ".ama", "workflows", `${id}.md`), text);

interface Rig {
  ctx: CommandContext;
  notices: string[];
  asked: ChooseSpec[];
  spawned: SubagentRequest[];
}

function rig(answers: (number | undefined)[] = [], ui = true): Rig {
  const spawned: SubagentRequest[] = [];
  const notices: string[] = [];
  const asked: ChooseSpec[] = [];
  const sessionId = `wfcmd-${++counter}`;
  const session = Object.create(AgentSessionImpl.prototype) as AgentSessionImpl;
  Object.defineProperties(session, {
    manager: { value: { id: sessionId, branch: () => [] } },
    cwd: { value: dir },
    state: { value: { sessionId, cwd: dir } },
    spawnSubagent: {
      value: async (req: SubagentRequest): Promise<SubagentResult> => {
        spawned.push(req);
        return {
          text: "done text",
          usage: {} as never,
          stopReason: "end_turn",
          isError: false,
          taskId: `t${spawned.length}`,
          status: "completed",
        };
      },
    },
    subscribe: { value: () => () => undefined },
    emit: { value: () => undefined },
    appendEntry: { value: async () => undefined },
    log: { value: () => undefined },
  });
  const workflow: WorkflowUi = {
    choose: async (spec) => {
      asked.push(spec);
      return answers.shift();
    },
    notice: (text) => void notices.push(text),
    wait: true,
  };
  const runtime = {
    paths: { configDir: join(dir, "cfg"), cwd: dir },
    trust: { trusted: true },
    config: {},
    providers: { findModel: () => ({ ok: false }) },
    host: undefined,
  } as unknown as Runtime;
  const ctx: CommandContext = {
    runtime,
    session: () => session,
    switchSession: async () => session,
    ...(ui ? { workflow } : {}),
  };
  return { ctx, notices, asked, spawned };
}

const text = (r: CommandResult | undefined): string =>
  r?.kind === "handled" ? (r.message ?? "") : "";

describe("参数解析", () => {
  it("引号、转义与空值", () => {
    expect(tokenize(`run demo topic="two words" note='a "b"' x=`)).toEqual([
      "run",
      "demo",
      "topic=two words",
      'note=a "b"',
      "x=",
    ]);
    expect(tokenize(String.raw`k="a \"q\" b"`)).toEqual(['k=a "q" b']);
    expect(parseParams(["a=1", "b=x=y", "a=2"])).toEqual({ a: "2", b: "x=y" });
  });
  it("坏参数与未闭合引号报用法", () => {
    expect(() => parseParams(["novalue"])).toThrow(/name=value/);
    expect(() => parseParams(["=v"])).toThrow(/name=value/);
    expect(() => tokenize('a="b')).toThrow(/name=value/);
  });
});

describe("list / show", () => {
  it("没有工作流提示、有工作流列出、无效文件带原因", async () => {
    const empty = rig();
    expect(text(await runSlashCommand("/workflow list", empty.ctx))).toMatch(/No workflows/);
    put("demo", FILE());
    put("broken", "---\nversion: 1\n---\n");
    const r = rig();
    const out = text(await runSlashCommand("/workflow list", r.ctx));
    expect(out).toContain("demo — Demo flow (1 step, project)");
    expect(out).toContain("broken.md");
  });

  it("show 列参数、角色与步骤；找不到报错", async () => {
    put("demo", FILE());
    const r = rig();
    const out = text(await runSlashCommand("/workflow show demo", r.ctx));
    expect(out).toContain("Parameters");
    expect(out).toContain("topic (string)");
    expect(out).toContain("a: ama");
    expect(out).toContain("first [prompt] a");
    await expect(runSlashCommand("/workflow show nope", r.ctx)).rejects.toThrow(
      "No workflow named nope.",
    );
  });

  it("无子命令回用法", async () => {
    expect(text(await runSlashCommand("/workflow", rig().ctx))).toMatch(/^\/workflow list/);
  });
});

describe("run", () => {
  it("预览确认后起跑并带参数；预览列角色与步骤数", async () => {
    put("demo", FILE());
    const r = rig([0]);
    const out = text(await runSlashCommand('/workflow run demo topic="big cats"', r.ctx));
    expect(r.asked[0]!.title).toBe("Run workflow demo?");
    expect(r.asked[0]!.body).toContain("a: ama  price unknown");
    expect(r.asked[0]!.body).toContain("1 step, 0 gates");
    expect(r.spawned).toHaveLength(1);
    expect(r.spawned[0]!.prompt).toContain("Write about big cats");
    expect(out).toContain("Workflow demo succeeded.");
    expect(out).toContain("done text");
  });

  it("预览取消不起任务", async () => {
    put("demo", FILE());
    const r = rig([1]);
    await runSlashCommand("/workflow run demo topic=x", r.ctx);
    expect(r.spawned).toHaveLength(0);
    const esc = rig([undefined]);
    await runSlashCommand("/workflow run demo topic=x", esc.ctx);
    expect(esc.spawned).toHaveLength(0);
  });

  it("缺参数、未知参数在预览前报错", async () => {
    put("demo", FILE());
    const r = rig([0]);
    await expect(runSlashCommand("/workflow run demo", r.ctx)).rejects.toThrow(
      "Parameter topic has no value.",
    );
    await expect(runSlashCommand("/workflow run demo topic=x extra=1", r.ctx)).rejects.toThrow(
      /extra/,
    );
    expect(r.asked).toHaveLength(0);
  });

  const GATE = `  - id: ok
    kind: gate
    label: Ship it?
    after: [first]
  - id: second
    kind: prompt
    role: a
    prompt: Next
    after: [ok]
`;

  it("gate 批准继续、拒绝停下", async () => {
    put("g", FILE("", GATE));
    const yes = rig([0, 0]);
    const done = text(await runSlashCommand("/workflow run g topic=x", yes.ctx));
    expect(yes.asked[1]!.title).toBe("Gate: Ship it?");
    expect(yes.spawned).toHaveLength(2);
    expect(done).toContain("succeeded");

    const no = rig([0, 1]);
    const stopped = text(await runSlashCommand("/workflow run g topic=x", no.ctx));
    expect(no.spawned).toHaveLength(1);
    expect(stopped).toContain("Workflow g failed.");
    expect(stopped).toContain("Gate ok was rejected.");
  });

  it("验证升级：接受继续、记为失败", async () => {
    const collect = `  - id: gather
    kind: collect
    role: a
    from: [first]
    prompt: Collect
    after: [first]
    verify:
      checklist: [looks right]
`;
    put("v", FILE("", collect));
    const accept = rig([0, 0]);
    const ok = text(await runSlashCommand("/workflow run v topic=x", accept.ctx));
    expect(accept.asked[1]!.title).toMatch(/^Step gather did not pass verification/);
    expect(ok).toContain("Workflow v succeeded.");
    const fail = rig([0, 1]);
    const bad = text(await runSlashCommand("/workflow run v topic=x", fail.ctx));
    expect(bad).toContain("Workflow v failed.");
  });

  it("没有界面时按 unattendedGate 处理 gate（缺省拒绝）", async () => {
    put("g", FILE("", GATE));
    const r = rig([], false);
    const out = text(await runSlashCommand("/workflow run g topic=x", r.ctx));
    expect(out).toContain("no one to ask");
    expect(r.spawned).toHaveLength(1);
  });

  it("交给宿主时显示链接，不起本地任务", async () => {
    put("demo", FILE());
    const context = createHostContext({});
    const { api } = createHostApi(
      {
        mode: "print",
        session: { id: () => "s", file: () => undefined, cwd: () => "/w", model: () => undefined },
        tools: { get: () => undefined, list: () => [], register() {}, disable() {} } as never,
        bus: new AgentEventBus(),
        sendUser: async () => "queued",
        stderr: () => undefined,
      },
      context,
    );
    api.workflows?.provide({
      versions: [2],
      run: async () => ({ runId: "h1", url: "armadra://canvas/h1" }),
    });
    const r = rig([0]);
    (r.ctx.runtime as unknown as { host: unknown }).host = { api };
    const out = text(await runSlashCommand("/workflow run demo topic=x", r.ctx));
    expect(out).toBe("Workflow demo was handed to the host: armadra://canvas/h1");
    expect(r.spawned).toHaveLength(0);
  });
});

describe("cancel / save", () => {
  it("没有在跑的工作流", async () => {
    expect(text(await runSlashCommand("/workflow cancel", rig().ctx))).toBe(
      "No workflow is running.",
    );
  });

  it("save 在本会话没有任务时提示", async () => {
    const r = rig();
    expect(text(await runSlashCommand("/workflow save", r.ctx))).toBe(
      "No sub-agent tasks in this session to turn into a workflow.",
    );
    expect(r.asked).toHaveLength(0);
  });

  const oneTask = (): void => {
    mockRegistry = {
      catalog: {},
      list: () => [
        {
          taskId: "t1",
          agent: "general",
          runner: "ama",
          description: "d",
          background: false,
          status: "completed",
          startedAt: 1,
          endedAt: 2,
        },
      ],
    };
  };

  it("save 没有交互界面时拒绝，不写文件", async () => {
    oneTask();
    const r = rig([], false);
    expect(text(await runSlashCommand("/workflow save mine", r.ctx))).toBe(
      "Saving a workflow needs an interactive session to confirm.",
    );
    expect(existsSync(join(dir, ".ama", "workflows", "mine.md"))).toBe(false);
  });

  it("save 确认缺省取消：取消不写，确认才写", async () => {
    oneTask();
    const no = rig([undefined]);
    await runSlashCommand("/workflow save mine", no.ctx);
    expect(no.asked[0]!.selected).toBe(1);
    expect(existsSync(join(dir, ".ama", "workflows", "mine.md"))).toBe(false);
    const yes = rig([0]);
    expect(text(await runSlashCommand("/workflow save mine", yes.ctx))).toMatch(/^Saved /);
    expect(existsSync(join(dir, ".ama", "workflows", "mine.md"))).toBe(true);
  });

  it("line 模式 Enter / Ctrl+C（缺省答案）对预览与保存确认都是取消", async () => {
    const prompts = workflowPrompts(
      lineChooser(
        async (_q, fallback) => fallback,
        () => undefined,
      ),
    );
    expect(await prompts.confirm("t", [], "Run", "Cancel")).toBe(false);
  });
});
