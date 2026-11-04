import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeHarness, tick, type BridgeHarness } from "../../../test/helpers/bridge-harness.js";
import type { FakePiConfig, FakePiTurn } from "../../../test/helpers/fake-pi.js";
import type {
  AcpRequestPermissionParams,
  AcpRequestPermissionResult,
} from "../../drivers/acp/types.js";
import type { RpcError } from "../../drivers/jsonrpc.js";
import { setLocale } from "../../i18n/index.js";

let h: BridgeHarness | undefined;
beforeEach(() => setLocale("en"));
afterEach(async () => {
  setLocale("zh");
  // 每条线上消息都要过官方 schema：校验失败在这里抛出
  await h?.finish();
  h = undefined;
});

const CWD = process.platform === "win32" ? "C:\\work" : "/work";
const text = (t: string) => [{ type: "text" as const, text: t }];
const allow: AcpRequestPermissionResult = {
  outcome: { outcome: "selected", optionId: "allow_once" },
};
const reject: AcpRequestPermissionResult = {
  outcome: { outcome: "selected", optionId: "reject_once" },
};

type Answer = (
  params: AcpRequestPermissionParams,
  signal: AbortSignal,
) => Promise<AcpRequestPermissionResult>;

async function open(
  pi: FakePiConfig,
  onPermission?: Answer,
  mcpServers: Record<string, unknown>[] = [],
) {
  const asked: AcpRequestPermissionParams[] = [];
  h = await bridgeHarness({
    pi,
    handlers: {
      onPermission: async (params, signal) => {
        asked.push(params);
        return onPermission !== undefined ? onPermission(params, signal) : reject;
      },
    },
  });
  await h.client.initialize();
  const created = await h.client.newSession(CWD, undefined, { mcpServers });
  return {
    h,
    asked,
    id: created.sessionId,
    created: created as unknown as Record<string, unknown>,
  };
}

/** 一轮：依次调用这些工具（都过闸）。 */
const calls =
  (
    ...list: {
      id: string;
      name: string;
      args?: Record<string, unknown>;
      gate?: Record<string, unknown>;
    }[]
  ) =>
  async (t: FakePiTurn) => {
    for (const c of list) await t.tool({ ...c, gate: c.gate ?? {} });
    t.assistantEnd({});
  };

/** pi 收到的审批应答（不含取理由的 editor 应答）。 */
const confirms = (harness: BridgeHarness): unknown[] =>
  harness.pi
    .last()
    .uiResponses.filter((r) => "confirmed" in r)
    .map((r) => r["confirmed"]);

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    return error as RpcError;
  }
  throw new Error("expected a rejection");
}

describe("modes", () => {
  it("session/new 答 modes：四个模式，缺省 default", async () => {
    const { created } = await open({});
    expect(created["modes"]).toEqual({
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Manual", description: expect.any(String) },
        { id: "auto-edit", name: "Accept edits", description: expect.any(String) },
        { id: "plan", name: "Plan", description: expect.any(String) },
        { id: "full-auto", name: "Bypass permissions", description: expect.any(String) },
      ],
    });
  });

  it("session/set_mode：发 current_mode_update；无效模式答 -32602", async () => {
    const { h, id } = await open({});
    await h.client.setMode(id, "plan");
    await tick(10);
    expect(h.updatesOf("current_mode_update")).toEqual([
      { sessionUpdate: "current_mode_update", currentModeId: "plan" },
    ]);
    expect((await rejection(h.client.setMode(id, "auto"))).code).toBe(-32602);
  });
});

describe("default：只读以外都交给人", () => {
  it("bash 经 session/request_permission 交给客户端：带 toolCallId、标题、类别、入参；允许后执行", async () => {
    const { h, asked, id } = await open(
      { onPrompt: calls({ id: "b1", name: "bash", args: { command: "echo hi" } }) },
      async () => allow,
    );
    await h.client.prompt(id, text("run"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      sessionId: id,
      toolCall: {
        toolCallId: "b1",
        title: "$ echo hi",
        kind: "execute",
        status: "pending",
        name: "bash",
        rawInput: { command: "echo hi" },
      },
      options: [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        { optionId: "reject_once", name: "Deny", kind: "reject_once" },
      ],
    });
    // pending → 放行后 in_progress → completed
    const states = h.updates
      .map((n) => n.update)
      .filter((u) => u.sessionUpdate.startsWith("tool_call"))
      .map((u) => (u as { status?: string }).status);
    expect(states).toEqual(["pending", "in_progress", "completed"]);
    expect(confirms(h)).toEqual([true]);
  });

  it("拒绝：调用以 failed 结束，模型得到默认理由", async () => {
    const { h, id } = await open(
      { onPrompt: calls({ id: "w1", name: "write", args: { path: "a.txt", content: "x" } }) },
      async () => reject,
    );
    await h.client.prompt(id, text("write"));
    expect(h.updatesOf("tool_call_update").at(-1)).toMatchObject({
      toolCallId: "w1",
      status: "failed",
    });
    expect(h.pi.last().reasons).toEqual(["write was not approved by the user"]);
  });

  it("客户端回 cancelled、或这个方法根本不支持：按拒绝，不代答放行", async () => {
    const cancelled = await open(
      { onPrompt: calls({ id: "b1", name: "bash", args: { command: "x" } }) },
      async () => ({ outcome: { outcome: "cancelled" } }),
    );
    await cancelled.h.client.prompt(cancelled.id, text("go"));
    expect(confirms(cancelled.h)).toEqual([false]);
    await cancelled.h.finish();
  });

  it("桥不代答：人没答之前 pi 的 confirm 一直挂着", async () => {
    let answer!: (r: AcpRequestPermissionResult) => void;
    const pending = new Promise<AcpRequestPermissionResult>((r) => (answer = r));
    const { h, asked, id } = await open(
      { onPrompt: calls({ id: "b1", name: "bash", args: { command: "x" } }) },
      () => pending,
    );
    const running = h.client.prompt(id, text("go"));
    await tick(50);
    expect(asked).toHaveLength(1);
    expect(h.pi.last().uiResponses).toEqual([]);
    answer(allow);
    await running;
    expect(confirms(h)).toEqual([true]);
  });

  it("只读内置与带 readOnlyHint 的 MCP 工具不问人", async () => {
    const { h, asked, id } = await open({
      onPrompt: async (t) => {
        await t.tool({ id: "r1", name: "read", args: { path: "a" } });
        await t.tool({ id: "m1", name: "mcp__s__peek", gate: { readOnly: true } });
        t.assistantEnd({});
      },
    });
    await h.client.prompt(id, text("peek"));
    expect(asked).toEqual([]);
    expect(confirms(h)).toEqual([true]);
  });
});

describe("取消", () => {
  it("session/cancel 撤回挂起的审批：客户端收到 $/cancel_request，pi 的 confirm 按拒绝应答，回合 cancelled", async () => {
    let seen: AbortSignal | undefined;
    const { h, id } = await open(
      {
        onPrompt: async (t) => {
          await t.tool({ id: "b1", name: "bash", args: { command: "x" }, gate: {} });
          await t.aborted;
        },
      },
      (_params, signal) => {
        seen = signal;
        return new Promise(() => undefined);
      },
    );
    const running = h.client.prompt(id, text("go"));
    await tick(50);
    await h.client.cancel(id);
    expect((await running).stopReason).toBe("cancelled");
    expect(seen?.aborted).toBe(true);
    expect(confirms(h)).toEqual([false]);
    expect(h.wire.some((w) => w.msg["method"] === "$/cancel_request" && w.dir === "out")).toBe(
      true,
    );
  });
});

describe("plan", () => {
  it("写与 bash 被拒绝，不打扰客户端；理由告诉模型在 plan 模式", async () => {
    const { h, asked, id } = await open({
      onPrompt: calls(
        { id: "w1", name: "write", args: { path: "a" } },
        { id: "b1", name: "bash", args: { command: "ls" } },
      ),
    });
    await h.client.setMode(id, "plan");
    await h.client.prompt(id, text("plan it"));
    expect(asked).toEqual([]);
    expect(h.pi.last().reasons).toHaveLength(2);
    expect(h.pi.last().reasons[0]).toMatch(/plan mode/);
    expect(h.updatesOf("tool_call_update").at(-1)).toMatchObject({
      toolCallId: "b1",
      status: "failed",
    });
  });

  it("只读 MCP 工具放行，非只读 MCP 工具拒绝", async () => {
    const { h, id } = await open({
      onPrompt: calls(
        { id: "m1", name: "mcp__s__peek", gate: { readOnly: true } },
        { id: "m2", name: "mcp__s__poke", gate: { readOnly: false } },
      ),
    });
    await h.client.setMode(id, "plan");
    await h.client.prompt(id, text("go"));
    expect(confirms(h)).toEqual([true, false]);
  });

  it("set_mode 立即生效：同一会话里先 plan 拒绝，切回 default 后交给人", async () => {
    const { h, asked, id } = await open(
      { onPrompt: calls({ id: "w1", name: "write", args: { path: "a" } }) },
      async () => allow,
    );
    await h.client.setMode(id, "plan");
    await h.client.prompt(id, text("one"));
    expect(asked).toEqual([]);
    await h.client.setMode(id, "default");
    await h.client.prompt(id, text("two"));
    expect(asked).toHaveLength(1);
  });
});

describe("auto-edit 与 full-auto", () => {
  it("auto-edit：edit / write 直接放行，bash 交给人", async () => {
    const { h, asked, id } = await open({
      onPrompt: calls(
        { id: "e1", name: "edit", args: { path: "a" } },
        { id: "w1", name: "write", args: { path: "b" } },
        { id: "b1", name: "bash", args: { command: "ls" } },
      ),
    });
    await h.client.setMode(id, "auto-edit");
    await h.client.prompt(id, text("go"));
    expect(asked.map((a) => a.toolCall.toolCallId)).toEqual(["b1"]);
  });

  it("full-auto：都放行；命中危险命令规则的 bash 仍交给人，拒绝则不执行", async () => {
    const { h, asked, id } = await open(
      {
        onPrompt: calls(
          { id: "w1", name: "write", args: { path: "a" } },
          { id: "b1", name: "bash", args: { command: "ls" } },
          { id: "b2", name: "bash", args: { command: "rm -rf /" } },
        ),
      },
      async () => reject,
    );
    await h.client.setMode(id, "full-auto");
    await h.client.prompt(id, text("go"));
    expect(asked.map((a) => a.toolCall.toolCallId)).toEqual(["b2"]);
    expect(confirms(h)).toEqual([true, true, false]);
  });
});

describe("MCP 透传", () => {
  const servers = [
    {
      name: "armadra",
      command: "/bin/armadra-mcp",
      args: ["--stdio"],
      env: [{ name: "K", value: "v" }],
    },
    {
      type: "http",
      name: "remote-api",
      url: "https://m.example/mcp",
      headers: [{ name: "A", value: "b" }],
    },
    { type: "sse", name: "legacy", url: "https://m.example/sse", headers: [] },
  ];

  it("mcpServers 写进 bridge.json 交给扩展（stdio 与 http），sse 跳过并在 stderr 说一行", async () => {
    const { h } = await open({}, undefined, servers);
    const instance = h.pi.last();
    expect(instance.bridgeConfig).toEqual({
      mcpServers: {
        armadra: { command: "/bin/armadra-mcp", args: ["--stdio"], env: { K: "v" } },
        "remote-api": { url: "https://m.example/mcp", headers: { A: "b" } },
      },
    });
    expect(instance.spec.env["AMA_BRIDGE_CONFIG"]).toMatch(/bridge\.json$/);
    expect(h.stderr.join("")).toMatch(/legacy/);
  });

  it("自家工具：tool_call 与权限请求都带 _meta.is_mcp_tool_call 与 rawInput {server, tool, arguments}", async () => {
    const { h, asked, id } = await open(
      {
        onPrompt: calls({
          id: "m1",
          name: "mcp__armadra__canvas_add",
          args: { kind: "note" },
          gate: { readOnly: false },
        }),
      },
      async () => allow,
      servers,
    );
    await h.client.prompt(id, text("add a note"));
    const expected = {
      title: "armadra: canvas_add",
      _meta: { is_mcp_tool_call: true },
      rawInput: { server: "armadra", tool: "canvas_add", arguments: { kind: "note" } },
    };
    expect(h.updatesOf("tool_call")[0]).toMatchObject(expected);
    expect(asked[0]?.toolCall).toMatchObject(expected);
  });

  it("服务器名里的连字符在 pi 的工具名里是下划线，仍认得出", async () => {
    const { h, id } = await open(
      { onPrompt: calls({ id: "m1", name: "mcp__remote_api__go", gate: { readOnly: true } }) },
      undefined,
      servers,
    );
    await h.client.prompt(id, text("go"));
    expect(h.updatesOf("tool_call")[0]).toMatchObject({
      rawInput: { server: "remote-api", tool: "go", arguments: {} },
    });
  });

  it("没有 mcpServers 时 bridge.json 里是空表；codemode 内层调用同样过闸", async () => {
    const { h, asked, id } = await open({
      onPrompt: calls({
        id: "outer/1",
        name: "bash",
        args: { command: "ls" },
        gate: { parent: "outer" },
      }),
    });
    expect(h.pi.last().bridgeConfig).toEqual({ mcpServers: {} });
    await h.client.prompt(id, text("go"));
    expect(asked[0]?.toolCall).toMatchObject({ _meta: { ama: { parentToolCallId: "outer" } } });
  });
});

describe("扩展报告的能力与 argv 透传", () => {
  it("_meta.armadra.pi.capabilities：Pi 里有没有 todo / subagent / questionnaire；没收到报告就不给", async () => {
    const none = await open({});
    expect((none.created["_meta"] as Record<string, unknown>)["armadra.pi"]).toMatchObject({
      capabilities: { todo: false, subagent: false, questionnaire: false },
    });
    await none.h.finish();
    const some = await open({ tools: ["read", "todo", "subagent"] });
    expect((some.created["_meta"] as Record<string, unknown>)["armadra.pi"]).toMatchObject({
      capabilities: { todo: true, subagent: true, questionnaire: false },
    });
    await some.h.finish();
    const silent = await open({ tools: null });
    expect(
      (silent.created["_meta"] as Record<string, Record<string, unknown>>)["armadra.pi"],
    ).not.toHaveProperty("capabilities");
  });

  it("MCP 注册失败写 stderr", async () => {
    const { h } = await open({ mcpFailures: ["bad: invalid config"] });
    expect(h.stderr.join("")).toMatch(/could not hand an MCP server to pi: bad: invalid config/);
  });

  it("-- 之后的参数原样交给 pi，排在桥自己的参数后面", async () => {
    h = await bridgeHarness({
      argv: [
        "--mode",
        "acp",
        "--bridge",
        "pi",
        "--",
        "--skill",
        "/s/a",
        "--append-system-prompt",
        "hi",
      ],
    });
    await h.client.initialize();
    const { sessionId } = await h.client.newSession(CWD);
    const args = h.pi.last().spec.args;
    expect(args.slice(0, 4)).toEqual(["--mode", "rpc", "--session-id", sessionId]);
    expect(args.slice(4, 5)).toEqual(["-e"]);
    expect(args.slice(6)).toEqual(["--skill", "/s/a", "--append-system-prompt", "hi"]);
  });
});
