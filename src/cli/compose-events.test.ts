import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../agent/types.js";
import { AgentEventBus } from "../host/api-impl.js";
import { bridgeEvent } from "./compose-events.js";

describe("bridgeEvent workflow_update（#318）", () => {
  it("forwards the update without the type tag", async () => {
    const bus = new AgentEventBus();
    const seen: unknown[] = [];
    bus.on("workflow_update", (payload) => void seen.push(payload));
    bridgeEvent(
      {
        type: "workflow_update",
        runId: "r1",
        workflowId: "w",
        title: "T",
        status: "running",
        host: true,
      } as SessionEvent,
      bus,
    );
    await Promise.resolve();
    expect(seen).toEqual([
      { runId: "r1", workflowId: "w", title: "T", status: "running", host: true },
    ]);
  });
});
