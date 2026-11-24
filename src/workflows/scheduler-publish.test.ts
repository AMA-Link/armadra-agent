import { describe, expect, it } from "vitest";
import type { SubagentRequest } from "../tools/types.js";
import type { WorkflowHost } from "./run-types.js";
import { runStandalone } from "./scheduler.js";
import type { WorkflowDocument } from "./types.js";

const doc: WorkflowDocument = {
  version: 2,
  title: "T",
  roles: [{ id: "a", agentId: "ama" }],
  steps: [{ id: "s1", kind: "prompt", role: "a", prompt: "go", after: [] }],
};

function host(sessionId: string, options: { throwRecord?: boolean; throwSpawn?: boolean } = {}) {
  const calls: SubagentRequest[] = [];
  const logs: string[] = [];
  const value: WorkflowHost = {
    sessionId,
    cwd: "/w",
    async spawn(request) {
      calls.push(request);
      if (options.throwSpawn) throw new Error("spawn boom");
      return {
        text: "out",
        usage: {} as never,
        stopReason: "end_turn",
        isError: false,
        taskId: "t1",
        status: "completed",
        report: { state: "ready", summary: "ok" },
      };
    },
    async wait() {
      throw new Error("unexpected wait");
    },
    tasks: () => [],
    onTaskEvent: () => () => undefined,
    agentAvailable: () => true,
    emit: () => undefined,
    record: () => {
      if (options.throwRecord) throw new Error("record boom");
    },
    log: (_level, message) => logs.push(message),
  };
  return { value, calls, logs };
}

describe("调度器发布失败不留下 workflow_busy", () => {
  it("record 抛错：只记 warn，运行照常结束，会话可再起新运行", async () => {
    const h = host("publish-1", { throwRecord: true });
    const result = await runStandalone(h.value, { workflow: doc }, {}).wait();
    expect(result.status).toBe("succeeded");
    expect(h.logs.some((m) => m.includes("workflow publish failed"))).toBe(true);
    const again = runStandalone(host("publish-1").value, { workflow: doc }, {});
    await expect(again.wait()).resolves.toMatchObject({ status: "succeeded" });
  });

  it("步骤抛错后会话同样被释放", async () => {
    const h = host("publish-2", { throwSpawn: true });
    await runStandalone(h.value, { workflow: doc }, {}).wait();
    expect(() => runStandalone(host("publish-2").value, { workflow: doc }, {})).not.toThrow();
  });
});
