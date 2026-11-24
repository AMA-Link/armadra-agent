import { describe, expect, it, vi } from "vitest";
import { bindWorkflowAgents } from "../workflows/runner.js";
import { createWorkflowsFactory } from "./compose-workflows.js";
import type { ComposeExtensionDeps } from "./compose-extensions.js";
import type { SessionExtensionContext } from "../agent/session-extensions.js";

vi.mock("../workflows/record.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workflows/record.js")>()),
  rebuildWorkflowRuns: (entries: readonly { data?: unknown }[]) =>
    entries.flatMap((e) => (e.data === undefined ? [] : [e.data])),
}));
const registry = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | {
        catalog: { get(name: string): { runner: string } | undefined };
        env: { runners?(agent: { runner: string }): unknown };
      },
}));
vi.mock("../agent/subagent-registry.js", () => ({ registryOf: () => registry.current }));
const active = vi.hoisted(() => ({ cancel: vi.fn(async () => {}) }));
vi.mock("../workflows/runner.js", () => ({
  bindWorkflowAgents: vi.fn(),
  activeWorkflow: (id: string) => (id === "s1" ? active : undefined),
}));

const deps = {} as unknown as ComposeExtensionDeps;

function core(depth: number, branch: unknown[] = []) {
  const appended: unknown[] = [];
  return {
    appended,
    ctx: {
      core: {
        depth,
        log: vi.fn(),
        manager: { id: "s1", branch: () => branch, append: (e: unknown) => appended.push(e) },
      },
    } as unknown as SessionExtensionContext,
  };
}

describe("createWorkflowsFactory", () => {
  it("does not install on child sessions", () => {
    expect(createWorkflowsFactory(deps)(core(1).ctx)).toBeUndefined();
  });

  it("on resume appends an interrupted snapshot for unfinished runs", () => {
    const run = {
      runId: "r1",
      status: "running",
      steps: [
        { id: "a", status: "done" },
        { id: "b", status: "running" },
        { id: "c", status: "pending" },
      ],
    };
    const c = core(0, [{ data: run }]);
    expect(createWorkflowsFactory(deps)(c.ctx)?.id).toBe("ama.workflows");
    expect(c.appended).toHaveLength(1);
    const entry = c.appended[0] as { customType: string; data: typeof run & { error: unknown } };
    expect(entry.customType).toBe("ama.workflow");
    expect(entry.data).toMatchObject({
      runId: "r1",
      status: "failed",
      error: { code: "interrupted" },
      steps: [{ status: "done" }, { status: "cancelled" }, { status: "cancelled" }],
    });
  });

  it("dispose cancels the running workflow", () => {
    active.cancel.mockClear();
    createWorkflowsFactory(deps)(core(0).ctx)?.dispose?.();
    expect(active.cancel).toHaveBeenCalledTimes(1);
  });

  it("起跑检查：general / ama 总可用；其它按任务注册表的目录与 runner 判断", () => {
    createWorkflowsFactory(deps)(core(0).ctx);
    const calls = vi.mocked(bindWorkflowAgents).mock.calls;
    const check = calls.at(-1)?.[1] as (name: string) => boolean;
    registry.current = undefined;
    expect([check("general"), check("ama"), check("claude")]).toEqual([true, true, false]);
    registry.current = {
      catalog: {
        get: (name) =>
          name === "claude" || name === "codex"
            ? { runner: name }
            : name === "mine"
              ? { runner: "ama" }
              : undefined,
      },
      env: { runners: (agent) => (agent.runner === "claude" ? {} : undefined) },
    };
    expect([check("claude"), check("codex"), check("mine"), check("nope")]).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });
});
