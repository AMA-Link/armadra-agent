import { describe, expect, it, vi } from "vitest";
import { AmaError } from "../errors.js";
import { runOnHost } from "./host-handoff.js";
import type {
  HostWorkflowHandler,
  HostWorkflowRunRequest,
  WorkflowFile,
  WorkflowHost,
  WorkflowRunRecord,
  WorkflowUpdate,
} from "./run-types.js";

const file: WorkflowFile = {
  id: "ship",
  scope: "project",
  filePath: "/w/.ama/workflows/ship.md",
  hash: "abc",
  workflow: {
    version: 2,
    title: "Ship it",
    params: [{ name: "topic", type: "string", default: "x" }],
    roles: [{ id: "a", agentId: "ama" }],
    steps: [{ id: "s1", kind: "prompt", role: "a", prompt: "do {{topic}}" }],
  } as never,
};

function fakeHost() {
  const updates: WorkflowUpdate[] = [];
  const records: WorkflowRunRecord[] = [];
  const logs: string[] = [];
  const host = {
    sessionId: "sess",
    cwd: "/w",
    emit: (u: WorkflowUpdate) => updates.push(u),
    record: (r: WorkflowRunRecord) => records.push(r),
    log: (_l: string, m: string) => logs.push(m),
  } as unknown as WorkflowHost;
  return { host, updates, records, logs };
}

describe("runOnHost", () => {
  it("passes the full request and records running with host.url, one update", async () => {
    const { host, updates, records } = fakeHost();
    const run = vi.fn(async (_r: HostWorkflowRunRequest) => ({
      runId: "h1",
      url: "armadra://w/1",
    }));
    const handler: HostWorkflowHandler = { versions: [2], run };
    const onUpdate = vi.fn();
    const handle = runOnHost(handler, host, file, { params: { topic: "t" }, onUpdate });
    expect(handle.host).toBe(true);
    const result = await handle.wait();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toMatchObject({
      workflowId: "ship",
      workflow: file.workflow,
      params: { topic: "t" },
      source: { scope: "project", filePath: file.filePath, hash: "abc" },
      sessionId: "sess",
      cwd: "/w",
    });
    expect(run.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({
      status: "running",
      host: { runId: "h1", url: "armadra://w/1" },
      steps: [],
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "running", host: true, workflowId: "ship" });
    expect(updates[0]).not.toHaveProperty("step");
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: "running",
      host: { runId: "h1", url: "armadra://w/1" },
      params: { topic: "t" },
    });
  });

  it("workflow_unsupported -> waiting with the host message", async () => {
    const { host, records } = fakeHost();
    const handler: HostWorkflowHandler = {
      versions: [2],
      run: async () => {
        throw new AmaError("workflow_unsupported", "confirm on the canvas");
      },
    };
    const result = await runOnHost(handler, host, file, {}).wait();
    expect(result.status).toBe("waiting");
    expect(result.error).toEqual({
      code: "workflow_unsupported",
      message: "confirm on the canvas",
    });
    expect(records[0]!.status).toBe("waiting");
  });

  it("other codes -> failed, code passed through", async () => {
    const { host, updates } = fakeHost();
    const handler: HostWorkflowHandler = {
      versions: [2],
      run: async () => {
        throw Object.assign(new Error("changed"), { code: "workflow_file_changed" });
      },
    };
    const result = await runOnHost(handler, host, file, {}).wait();
    expect(result.status).toBe("failed");
    expect(result.error).toEqual({ code: "workflow_file_changed", message: "changed" });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.status).toBe("failed");
  });

  it("cancel throws workflow_unsupported; respondGate is false", async () => {
    const { host } = fakeHost();
    const handle = runOnHost({ versions: [2], run: async () => ({ runId: "h" }) }, host, file, {});
    await expect(handle.cancel()).rejects.toMatchObject({ code: "workflow_unsupported" });
    expect(handle.respondGate("s1", "approve")).toBe(false);
    await handle.wait();
  });

  it("rejects undeclared params before handing over", () => {
    const { host } = fakeHost();
    const run = vi.fn();
    expect(() =>
      runOnHost({ versions: [2], run } as never, host, file, { params: { nope: "1" } }),
    ).toThrow(/no parameter/);
    expect(run).not.toHaveBeenCalled();
  });
});
