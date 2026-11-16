/**
 * `commands.register`（#301）：注册规则、分派顺序（内置之后、提示模板之前）、结果校验、
 * `/help`、补全与 RPC `get_commands` / `prompt` 里的列出与分派。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n/index.js";
import type { AgentSession } from "../agent/types.js";
import type { Runtime } from "../cli/runtime.js";
import { HostCommandRegistry } from "../host/commands.js";
import { createHostApi, createHostContext, AgentEventBus } from "../host/api-impl.js";
import type { HostApi } from "../host/types.js";
import {
  availableCommands,
  BUILTIN_COMMANDS,
  INTERACTIVE_COMMAND_NAMES,
  isReservedCommandName,
  runSlashCommand,
} from "./commands-core.js";
import { INTERACTIVE_COMMANDS, completionCommands } from "./interactive/commands.js";
import { handlers, type RpcContext } from "./rpc/commands.js";

beforeAll(() => setLocale("en"));
afterAll(() => setLocale("zh"));

function fixture() {
  const context = createHostContext({ reservedCommand: isReservedCommandName });
  const make = (): HostApi =>
    createHostApi(
      {
        mode: "print",
        session: { id: () => "s", file: () => undefined, cwd: () => "/w", model: () => undefined },
        tools: { get: () => undefined, list: () => [], register() {}, disable() {} } as never,
        bus: new AgentEventBus(),
        sendUser: async () => "queued",
        stderr: () => undefined,
      },
      context,
    ).api;
  const session = {
    state: { sessionId: "sess-1", cwd: "/work" },
    getTools: () => [],
    subscribe: () => () => undefined,
    prompt: vi.fn(async () => "started" as const),
  } as unknown as AgentSession;
  const runtime = {
    mode: "print",
    tools: { list: () => [] },
    hostCommands: context.commands,
    resources: { prompts: [{ name: "standup" }], skills: [] },
  } as unknown as Runtime;
  const cmdCtx = { runtime, session: () => session, switchSession: async () => session };
  return { api: make(), make, runtime, session, cmdCtx };
}

const ok = { description: "d", run: () => ({ kind: "handled" as const }) };

describe("注册规则", () => {
  it("名称格式、内置命令与别名、重复注册都抛错；注销后可再注册", () => {
    const { api } = fixture();
    for (const name of ["Bad", "1x", "a_b", "", "x".repeat(65), "skill:x"]) {
      expect(() => api.commands?.register({ name, ...ok })).toThrow(/invalid command name/);
    }
    for (const name of ["help", "model", "exit", "q", "quit", "tree", "permissions", "memory"]) {
      expect(() => api.commands?.register({ name, ...ok })).toThrow(/built-in/);
    }
    expect(() => api.commands?.register({ name: "x", description: "", run: ok.run })).toThrow(
      /description/,
    );
    expect(() => api.commands?.register({ name: "x", description: "d" } as never)).toThrow(/run/);
    const off = api.commands?.register({ name: "standup", ...ok });
    expect(() => api.commands?.register({ name: "standup", ...ok })).toThrow(/already exists/);
    expect(api.commands?.list()).toEqual(["standup"]);
    off?.();
    expect(api.commands?.list()).toEqual([]);
    expect(() => api.commands?.register({ name: "standup", ...ok })).not.toThrow();
  });

  it("多个模块共用一张表：另一个模块注册同名也抛错", () => {
    const { api, make } = fixture();
    api.commands?.register({ name: "dup", ...ok });
    expect(() => make().commands?.register({ name: "dup", ...ok })).toThrow(/already exists/);
  });

  it("保留名与内置表、交互命令表保持一致", () => {
    for (const c of BUILTIN_COMMANDS) expect(isReservedCommandName(c.name)).toBe(true);
    expect([...INTERACTIVE_COMMAND_NAMES].sort()).toEqual(
      INTERACTIVE_COMMANDS.map((c) => c.name).sort(),
    );
    expect(new HostCommandRegistry().list()).toEqual([]);
  });
});

describe("分派", () => {
  it("先于提示模板：同名模板不会被用到；未注册的名字仍返回 undefined", async () => {
    const { api, cmdCtx } = fixture();
    const run = vi.fn(() => ({ kind: "handled" as const, message: "ok" }));
    api.commands?.register({ name: "standup", description: "d", run });
    expect(await runSlashCommand("/standup  a b ", cmdCtx)).toEqual({
      kind: "handled",
      message: "ok",
    });
    expect(run).toHaveBeenCalledWith("a b", {
      mode: "print",
      session: expect.objectContaining({ id: expect.any(Function), cwd: expect.any(Function) }),
    });
    const ctxArg = (
      run.mock.calls[0] as unknown as [string, { session: { id(): string; cwd(): string } }]
    )[1];
    expect([ctxArg.session.id(), ctxArg.session.cwd()]).toEqual(["sess-1", "/work"]);
    expect(await runSlashCommand("/unknown", cmdCtx)).toBeUndefined();
  });

  it("prompt 结果原样给出；undefined 等同 handled；形状不对抛错；命令自己抛的错上抛", async () => {
    const { api, cmdCtx } = fixture();
    api.commands?.register({
      name: "p",
      description: "d",
      run: () => ({ kind: "prompt", text: "hello" }),
    });
    api.commands?.register({ name: "n", description: "d", run: () => undefined });
    api.commands?.register({
      name: "bad",
      description: "d",
      run: () => ({ kind: "pick" }) as never,
    });
    api.commands?.register({
      name: "empty",
      description: "d",
      run: () => ({ kind: "prompt", text: "" }),
    });
    api.commands?.register({
      name: "boom",
      description: "d",
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(await runSlashCommand("/p", cmdCtx)).toEqual({ kind: "prompt", text: "hello" });
    expect(await runSlashCommand("/n", cmdCtx)).toEqual({ kind: "handled" });
    await expect(runSlashCommand("/bad", cmdCtx)).rejects.toThrow(/invalid result/);
    await expect(runSlashCommand("/empty", cmdCtx)).rejects.toThrow(/invalid result/);
    await expect(runSlashCommand("/boom", cmdCtx)).rejects.toThrow("boom");
  });
});

describe("列出", () => {
  it("/help、补全与 RPC get_commands 都含扩展命令（source: extension）", async () => {
    const { api, runtime, session, cmdCtx } = fixture();
    api.commands?.register({
      name: "standup",
      description: "Daily summary",
      args: "[day]",
      run: ok.run,
    });
    const help = await runSlashCommand("/help", cmdCtx);
    expect(help?.kind === "handled" ? help.message : "").toContain("/standup [day]  Daily summary");
    expect(completionCommands(runtime, session).map((c) => c.name)).toContain("standup");
    expect(availableCommands(runtime, session).at(-1)).toMatchObject({
      name: "standup",
      source: "extension",
    });
    const rpc = { runtime, session: () => session } as unknown as RpcContext;
    const listed = (await handlers.get_commands({} as never, rpc)) as {
      commands: { name: string; source: string; description?: string }[];
    };
    expect(listed.commands.find((c) => c.name === "standup")).toEqual({
      name: "standup",
      description: "Daily summary",
      source: "extension",
    });
    expect(listed.commands.find((c) => c.name === "help")?.source).toBe("builtin");
  });

  it("RPC prompt：handled 回 notification 且不开回合；prompt 改发文本；其它行照常", async () => {
    const { api, runtime, session } = fixture();
    api.commands?.register({
      name: "say",
      description: "d",
      run: (a) => ({ kind: "handled", message: `said ${a}` }),
    });
    api.commands?.register({
      name: "ask",
      description: "d",
      run: (a) => ({ kind: "prompt", text: `Please ${a}` }),
    });
    const notes: string[] = [];
    const rpc = {
      runtime,
      session: () => session,
      notify: (m: string) => notes.push(m),
    } as unknown as RpcContext;
    expect(await handlers.prompt({ message: "/say hi" } as never, rpc)).toEqual({
      disposition: "handled",
    });
    expect(notes).toEqual(["said hi"]);
    expect(session.prompt).not.toHaveBeenCalled();
    await handlers.prompt({ message: "/ask review" } as never, rpc);
    expect(session.prompt).toHaveBeenLastCalledWith("Please review", {});
    await handlers.prompt({ message: "plain text" } as never, rpc);
    expect(session.prompt).toHaveBeenLastCalledWith("plain text", {});
  });
});
