import { describe, expect, it } from "vitest";
import { BRIDGE_MODES, isBridgeMode, parseGateCall, verdictFor, type GateCall } from "./gate.js";
import { mcpToolOf, piToolSegment } from "./tools.js";
import { piMcpPlan } from "./mcp.js";

const call = (tool: string, input: Record<string, unknown> = {}, readOnly = false): GateCall => ({
  id: "c1",
  tool,
  input,
  readOnly,
});

describe("verdictFor：四个模式", () => {
  it("default：只读放行，其余交给人", () => {
    expect(verdictFor("default", call("read")).kind).toBe("allow");
    expect(verdictFor("default", call("mcp__s__t", {}, true)).kind).toBe("allow");
    for (const tool of ["bash", "edit", "write", "mcp__s__t"])
      expect(verdictFor("default", call(tool)).kind).toBe("ask");
  });

  it("auto-edit：edit / write 放行，bash 与非只读 MCP 交给人", () => {
    expect(verdictFor("auto-edit", call("edit")).kind).toBe("allow");
    expect(verdictFor("auto-edit", call("write")).kind).toBe("allow");
    expect(verdictFor("auto-edit", call("bash", { command: "ls" })).kind).toBe("ask");
    expect(verdictFor("auto-edit", call("mcp__s__t")).kind).toBe("ask");
  });

  it("plan：只读（内置或 readOnlyHint）放行，其余拒绝并告诉模型在 plan 模式", () => {
    expect(verdictFor("plan", call("grep")).kind).toBe("allow");
    expect(verdictFor("plan", call("mcp__s__t", {}, true)).kind).toBe("allow");
    const denied = verdictFor("plan", call("write"));
    expect(denied).toMatchObject({ kind: "deny" });
    expect((denied as { reason: string }).reason).toMatch(/plan mode/);
    expect(verdictFor("plan", call("bash", { command: "ls" })).kind).toBe("deny");
    expect(verdictFor("plan", call("mcp__s__t")).kind).toBe("deny");
  });

  it("full-auto：都放行，命中危险命令规则的 bash 仍交给人", () => {
    expect(verdictFor("full-auto", call("write")).kind).toBe("allow");
    expect(verdictFor("full-auto", call("mcp__s__t")).kind).toBe("allow");
    expect(verdictFor("full-auto", call("bash", { command: "ls -la" })).kind).toBe("allow");
    expect(verdictFor("full-auto", call("bash", { command: "rm -rf /" })).kind).toBe("ask");
    expect(
      verdictFor("full-auto", call("bash", { command: "git push --force origin main" })).kind,
    ).toBe("ask");
    // 不是 shell 工具的入参里写了 command 也不算
    expect(verdictFor("full-auto", call("mcp__s__t", { command: "rm -rf /" })).kind).toBe("allow");
  });

  it("模式清单与 ama 同名", () => {
    expect(BRIDGE_MODES).toEqual(["default", "auto-edit", "plan", "full-auto"]);
    expect(isBridgeMode("plan")).toBe(true);
    expect(isBridgeMode("auto")).toBe(false);
  });
});

describe("parseGateCall", () => {
  it("扩展按固定形状序列化；形状不对返回 undefined", () => {
    expect(
      parseGateCall(
        JSON.stringify({
          id: "a",
          tool: "bash",
          input: { command: "x" },
          readOnly: true,
          parent: "p",
        }),
      ),
    ).toEqual({ id: "a", tool: "bash", input: { command: "x" }, readOnly: true, parent: "p" });
    expect(parseGateCall(JSON.stringify({ id: "a", tool: "t" }))).toEqual({
      id: "a",
      tool: "t",
      input: {},
      readOnly: false,
    });
    expect(parseGateCall("not json")).toBeUndefined();
    expect(parseGateCall(JSON.stringify({ tool: "t" }))).toBeUndefined();
    expect(parseGateCall(undefined)).toBeUndefined();
  });
});

describe("MCP 工具名与 bridge.json 配置", () => {
  it("mcpToolOf：只认桥注册过的服务器，取最长匹配；连字符在 Pi 名字里是下划线", () => {
    expect(piToolSegment("my-srv.v2")).toBe("my_srv_v2");
    expect(mcpToolOf("mcp__armadra__canvas_add", ["armadra"])).toEqual({
      server: "armadra",
      tool: "canvas_add",
    });
    expect(mcpToolOf("mcp__my_srv__go", ["my-srv"])).toEqual({ server: "my-srv", tool: "go" });
    expect(mcpToolOf("mcp__a_b__t", ["a", "a-b"])).toEqual({ server: "a-b", tool: "t" });
    expect(mcpToolOf("mcp__other__t", ["armadra"])).toBeUndefined();
    expect(mcpToolOf("bash", ["armadra"])).toBeUndefined();
  });

  it("piMcpPlan：stdio 与 http 转成 Pi 的配置，sse 与缺名字的跳过，名字规整", () => {
    const plan = piMcpPlan([
      {
        name: "armadra",
        command: "/bin/armadra-mcp",
        args: ["--x"],
        env: [{ name: "TOKEN", value: "t" }],
      },
      {
        type: "http",
        name: "remote.api",
        url: "https://m.example/mcp",
        headers: [{ name: "A", value: "b" }],
      },
      { type: "sse", name: "old", url: "https://m.example/sse", headers: [] },
      { command: "x" },
    ]);
    expect(plan.servers).toEqual({
      armadra: { command: "/bin/armadra-mcp", args: ["--x"], env: { TOKEN: "t" } },
      remote_api: { url: "https://m.example/mcp", headers: { A: "b" } },
    });
    expect(plan.names).toEqual(["armadra", "remote.api"]);
    expect(plan.skipped).toEqual(["old", "#4"]);
    expect(piMcpPlan(undefined)).toEqual({ servers: {}, names: [], skipped: [] });
  });
});
