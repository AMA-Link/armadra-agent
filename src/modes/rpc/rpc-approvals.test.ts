/**
 * [#271] RpcApprovals：已结算（答过 / 被撤回）的 requestId 迟到的 `permission_response` 直接丢弃，不进暂存；
 * 暂存与已结算表都有上限。
 */

import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../../permissions/types.js";
import { RPC_APPROVALS_EARLY_LIMIT, RpcApprovals } from "./commands.js";

const req = (id: string): ApprovalRequest => ({
  requestId: id,
  toolName: "bash",
  input: { command: "ls" },
  reason: "mode",
});

describe("RpcApprovals.respond", () => {
  it("在等的作答；被撤回后迟到的回复丢弃，同 id 再问不会被预答", async () => {
    const approvals = new RpcApprovals();
    const c = new AbortController();
    const first = approvals.ask(req("r1"), c.signal);
    c.abort();
    expect(await first).toBeUndefined();
    expect(approvals.respond("r1", "allow")).toBe(false);
    let answered = false;
    const again = approvals.ask(req("r1"), new AbortController().signal).then((d) => {
      answered = true;
      return d;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(answered).toBe(false);
    expect(approvals.respond("r1", "deny")).toBe(true);
    expect(await again).toBe("deny");
    expect(approvals.respond("r1", "allow")).toBe(false);
  });

  it("没结算过的提前回答暂存并在被问到时生效；暂存超上限丢最旧", async () => {
    const approvals = new RpcApprovals();
    expect(approvals.respond("early", "allow")).toBe(false);
    expect(await approvals.ask(req("early"), new AbortController().signal)).toBe("allow");
    for (let i = 0; i <= RPC_APPROVALS_EARLY_LIMIT; i++) approvals.respond(`e${i}`, "deny");
    let answered = false;
    void approvals.ask(req("e0"), new AbortController().signal).then(() => (answered = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(answered).toBe(false);
    expect(await approvals.ask(req("e1"), new AbortController().signal)).toBe("deny");
  });
});
