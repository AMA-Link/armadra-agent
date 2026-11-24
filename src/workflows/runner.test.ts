import { describe, expect, it, vi } from "vitest";
import { activeWorkflow, startWorkflow } from "./runner.js";
import type {
  HostWorkflowHandler,
  WorkflowFile,
  WorkflowHost,
  WorkflowRunHandle,
} from "./run-types.js";

const doc = {
  version: 2,
  title: "T",
  roles: [{ id: "a", agentId: "ama" }],
  steps: [{ id: "s1", kind: "prompt", role: "a", prompt: "p" }],
} as never;
const file: WorkflowFile = {
  id: "w",
  scope: "project",
  filePath: "/w/w.md",
  hash: "h",
  workflow: doc,
};

function host() {
  const logs: string[] = [];
  return {
    h: {
      sessionId: "s-runner",
      cwd: "/w",
      log: (_l: string, m: string) => logs.push(m),
      emit() {},
      record() {},
    } as unknown as WorkflowHost,
    logs,
  };
}
function handleOf(): WorkflowRunHandle & { finish(): void } {
  let finish!: () => void;
  const p = new Promise<void>((r) => (finish = r));
  return {
    runId: "r",
    host: false,
    wait: async () => {
      await p;
      return { runId: "r", workflowId: "w", status: "succeeded", steps: [], outputs: [] };
    },
    cancel: async () => {},
    respondGate: () => false,
    finish,
  };
}

describe("startWorkflow", () => {
  it("hands a file to a matching host handler", async () => {
    const { h } = host();
    const standalone = vi.fn();
    const run = vi.fn(async () => ({ runId: "x" }));
    const handle = startWorkflow(h, file, { hostHandler: { versions: [1, 2], run } }, standalone);
    expect(handle.host).toBe(true);
    await handle.wait();
    expect(run).toHaveBeenCalledTimes(1);
    expect(standalone).not.toHaveBeenCalled();
    expect(activeWorkflow("s-runner")).toBeUndefined();
  });

  it("runs inline documents standalone even with a handler", () => {
    const { h } = host();
    const run = vi.fn();
    const standalone = vi.fn(() => handleOf());
    startWorkflow(h, { workflow: doc }, { hostHandler: { versions: [2], run } }, standalone);
    expect(run).not.toHaveBeenCalled();
    expect(standalone).toHaveBeenCalledTimes(1);
  });

  it("version mismatch -> standalone and one warn", () => {
    const { h, logs } = host();
    const standalone = vi.fn(() => handleOf());
    const handler: HostWorkflowHandler = { versions: [1], run: vi.fn() };
    startWorkflow(h, file, { hostHandler: handler, params: { a: "b" } }, standalone);
    expect(standalone).toHaveBeenCalledWith(h, file, { params: { a: "b" } });
    expect(logs).toEqual(["host cannot run workflow version 2; running it here"]);
  });

  it("no handler -> standalone; active until it settles", async () => {
    const { h, logs } = host();
    const handle = handleOf();
    startWorkflow(h, file, {}, () => handle);
    expect(activeWorkflow("s-runner")).toBe(handle);
    handle.finish();
    await handle.wait();
    await Promise.resolve();
    expect(activeWorkflow("s-runner")).toBeUndefined();
    expect(logs).toEqual([]);
  });
});
