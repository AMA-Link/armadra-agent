/**
 * [#266] 前台 bash 超过阈值原地转后台 + [#267] 后台任务寿命上限的工具面。真子进程（POSIX）；阈值与寿命计时器
 * 用手动时钟，只等待真实事件（输出、退出），不靠墙钟。
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualTimers } from "../../test/helpers/manual-timers.js";
import { makeTmpDir, makeToolContext } from "../../test/helpers/tool-context.js";
import { createHarness } from "../agent/testing/harness.js";
import { createRemindersExtension, REMINDER_CUSTOM_TYPE } from "../agent/reminders.js";
import { userTexts } from "../agent/testing/harness.js";
import { waitUntil } from "../agent/testing/subagent-harness.js";
import { resolveBashAutoBackgroundMs } from "../cli/compose.js";
import { BackgroundJobs, jobsForSession } from "./background-jobs.js";
import {
  createBashTool,
  DEFAULT_BASH_AUTO_BACKGROUND_MS,
  type BackgroundStart,
  type BashStructured,
} from "./bash.js";
import type { ToolDefinition } from "./types.js";

const posix = process.platform !== "win32";
let tmp: { dir: string; cleanup(): void };
let jobs: BackgroundJobs;
beforeEach(() => {
  tmp = makeTmpDir();
  jobs = new BackgroundJobs();
});
afterEach(async () => {
  await jobs.disposeAll();
  tmp.cleanup();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type Moved = BackgroundStart & { movedToBackground: true; output: string };

describe("resolveBashAutoBackgroundMs（组装根的缺省）", () => {
  it("显式值优先（含 0 = 关）；没写时 rpc / 嵌入宿主 / coordinator 为 15 s，独立交互与 -p 为 0", () => {
    expect(resolveBashAutoBackgroundMs({}, "interactive")).toBe(0);
    expect(resolveBashAutoBackgroundMs({}, "line")).toBe(0);
    expect(resolveBashAutoBackgroundMs({}, "print")).toBe(0);
    expect(resolveBashAutoBackgroundMs({}, "rpc")).toBe(DEFAULT_BASH_AUTO_BACKGROUND_MS);
    expect(resolveBashAutoBackgroundMs({}, "interactive", true)).toBe(
      DEFAULT_BASH_AUTO_BACKGROUND_MS,
    );
    expect(resolveBashAutoBackgroundMs({ tools: { preset: "coordinator" } }, "print")).toBe(
      DEFAULT_BASH_AUTO_BACKGROUND_MS,
    );
    expect(
      resolveBashAutoBackgroundMs({ tools: { bashAutoBackgroundAfterMs: 0 } }, "rpc", true),
    ).toBe(0);
    expect(
      resolveBashAutoBackgroundMs({ tools: { bashAutoBackgroundAfterMs: 4000 } }, "interactive"),
    ).toBe(4000);
  });
});

describe.runIf(posix)("前台 bash 转后台（真子进程）", () => {
  it("阈值内结束的命令结果与关闭时逐字节一致；阈值 0 不起计时器", async () => {
    const timers = manualTimers();
    const on = createBashTool({ jobs: () => jobs, autoBackgroundAfterMs: 15_000, timers });
    const off = createBashTool({ jobs: () => jobs, autoBackgroundAfterMs: 0, timers });
    const command = "echo out; echo err >&2; exit 2";
    const a = await on.execute({ command }, makeToolContext(tmp.dir));
    expect(timers.delays).toEqual([15_000]);
    expect(timers.pending()).toEqual([]); // 结束时清掉
    const b = await off.execute({ command }, makeToolContext(tmp.dir));
    expect(timers.delays).toEqual([15_000]); // 0 = 关：没有再登记
    expect(a.content).toBe(b.content);
    expect(a.isError).toBe(b.isError);
    const sa = { ...(a.structured as BashStructured), wall_time_seconds: 0 };
    const sb = { ...(b.structured as BashStructured), wall_time_seconds: 0 };
    expect(sa).toEqual(sb);
    expect(jobs.list()).toEqual([]);
  });

  it("到点仍在跑：原地转后台（进程不重启）、返回已有输出；之后 Esc 不杀它，退出经 takeExited 通知", async () => {
    const timers = manualTimers();
    const tool = createBashTool({
      jobs: () => jobs,
      autoBackgroundAfterMs: 15_000,
      backgroundMaxMs: 7_200_000,
      timers,
    });
    const ctx = makeToolContext(tmp.dir, { outputDir: tmp.dir });
    const running = tool.execute({ command: 'echo "pid=$$"; sleep 30' }, ctx);
    await waitUntil(() => ctx.updates.some((u) => u.includes("pid=")), 5000);
    timers.fire(0);
    const result = await running;
    const moved = result.structured as Moved;
    expect(result.isError).toBeUndefined();
    expect(moved.movedToBackground).toBe(true);
    expect(moved.jobId).toBe("bg1");
    const shellPid = Number(/pid=(\d+)/.exec(moved.output)?.[1]);
    expect(moved.pid).toBe(shellPid); // 同一个进程
    expect(String(result.content)).toContain(`pid=${shellPid}`);
    expect(String(result.content)).toContain(
      "[Still running after 15s; moved to background job bg1",
    );
    expect(String(result.content)).toContain("It is stopped after 120 min unless extended once");
    // 输出文件里有转后台之前的输出
    expect(readFileSync(moved.outputPath, "utf8")).toContain(`pid=${shellPid}`);
    const job = jobs.get("bg1");
    expect(job).toMatchObject({ moved: true, status: "running", pid: shellPid });
    expect(job?.lifetime).toMatchObject({ maxMs: 7_200_000, extended: false });
    // 寿命计时器从转换时刻登记
    expect(timers.pending()).toEqual([{ ms: 7_200_000 }]);
    // 转后台之后父调用的 abort 不再杀它
    ctx.controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive(shellPid)).toBe(true);
    // 命令自然退出：查询照常可用
    const out = await tool.execute({ job: "bg1", action: "output" }, ctx);
    expect(String(out.content)).toContain("still running");
    const stopped = await tool.execute({ job: "bg1", action: "stop" }, ctx);
    expect(String(stopped.content)).toContain("[job bg1 stopped (exit code");
    expect(alive(shellPid)).toBe(false);
    expect(timers.pending()).toEqual([]);
  });

  it("转后台后自然退出：takeExited 取走一次；输出文件包含转换前后的全部输出", async () => {
    const timers = manualTimers();
    const tool = createBashTool({ jobs: () => jobs, autoBackgroundAfterMs: 1000, timers });
    const ctx = makeToolContext(tmp.dir, { outputDir: tmp.dir });
    const gate = `${tmp.dir}/go`;
    const running = tool.execute(
      { command: `echo before; while [ ! -e ${gate} ]; do sleep 0.05; done; echo after; exit 4` },
      ctx,
    );
    await waitUntil(() => ctx.updates.some((u) => u.includes("before")), 5000);
    timers.fire(0);
    const result = await running;
    expect((result.structured as Moved).output).toBe("before\n");
    await (await import("node:fs/promises")).writeFile(gate, "");
    const job = await jobs.wait("bg1", 5000);
    expect(job).toMatchObject({ status: "exited", exitCode: 4 });
    expect(readFileSync(job?.outputPath as string, "utf8")).toBe("before\nafter\n");
    expect(jobs.takeExited().map((j) => j.id)).toEqual(["bg1"]);
  });

  it("超时比阈值先到：照旧杀掉并报超时，不转后台", async () => {
    const timers = manualTimers();
    const tool = createBashTool({ jobs: () => jobs, autoBackgroundAfterMs: 60_000, timers });
    const r = await tool.execute({ command: "sleep 30", timeoutMs: 300 }, makeToolContext(tmp.dir));
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("timed out after 300 ms");
    expect(jobs.list()).toEqual([]);
    expect(timers.pending()).toEqual([]);
  });

  it("extend：后台任务续命一次（增量封顶一个上限）；再续被拒；上限 0 的任务没有可续", async () => {
    const timers = manualTimers();
    const tool = createBashTool({ jobs: () => jobs, backgroundMaxMs: 60_000, timers });
    const ctx = makeToolContext(tmp.dir, { outputDir: tmp.dir });
    await tool.execute({ command: "sleep 30", background: true }, ctx);
    expect(timers.pending()).toEqual([{ ms: 60_000 }]);
    const once = await tool.execute({ job: "bg1", action: "extend", timeoutMs: 600_000 }, ctx);
    expect(once.isError).toBeUndefined();
    expect(String(once.content)).toBe(
      "[job bg1 lifetime extended by 1 min; it is now stopped after 2 min in total. It cannot be extended again.]",
    );
    expect(timers.pending()).toHaveLength(1);
    const twice = await tool.execute({ job: "bg1", action: "extend" }, ctx);
    expect(twice.isError).toBe(true);
    expect(String(twice.content)).toContain("already extended once");
    const bad = await tool.execute({ job: "bg1", action: "extend", timeoutMs: -1 }, ctx);
    expect(bad.isError).toBe(true);
    const unlimited = createBashTool({ jobs: () => jobs, backgroundMaxMs: 0, timers });
    await unlimited.execute({ command: "sleep 30", background: true }, ctx);
    const none = await unlimited.execute({ job: "bg2", action: "extend" }, ctx);
    expect(String(none.content)).toBe("[job bg2 has no lifetime cap; nothing to extend]");
    expect(jobs.get("bg2")?.lifetime).toBeUndefined();
  });

  it("寿命到点：杀掉进程树，提醒文案说明寿命上限；stop 的不提醒", async () => {
    const timers = manualTimers();
    const tool = createBashTool({ jobs: () => jobs, backgroundMaxMs: 120_000, timers });
    const ctx = makeToolContext(tmp.dir, { outputDir: tmp.dir });
    const started = await tool.execute({ command: "sleep 30", background: true }, ctx);
    const { pid } = started.structured as BackgroundStart;
    expect(String(started.content)).toContain(
      'It is stopped after 2 min unless extended once with {"job":"bg1","action":"extend"}.',
    );
    timers.fire(0);
    const job = await jobs.wait("bg1", 5000);
    expect(job).toMatchObject({ status: "stopped", expired: true });
    expect(alive(pid as number)).toBe(false);
    const out = await tool.execute({ job: "bg1", action: "output" }, ctx);
    expect(String(out.content)).toContain("[job bg1 stopped at its lifetime cap (2 min; exit code");
  });
});

describe.runIf(posix)("转后台期间的插话（脚本化供应商 + 手动时钟）", () => {
  it("插话在转后台后的下一步进入模型；退出后下次提示前收到提醒", async () => {
    const timers = manualTimers();
    // 不注入任务表：工具与提醒通道都按会话 id 取同一份（jobsForSession）
    const bash = createBashTool({ autoBackgroundAfterMs: 15_000, timers }) as ToolDefinition;
    const gate = `${tmp.dir}/go`;
    const h = createHarness({
      cwd: tmp.dir,
      tools: [bash],
      extensions: [({ core }) => createRemindersExtension(core)],
      script: (call) => {
        const last = userTexts(call.context).at(-1) ?? "";
        if (last === "go")
          return {
            toolCalls: [
              {
                name: "bash",
                args: { command: `echo started; while [ ! -e ${gate} ]; do sleep 0.05; done` },
              },
            ],
          };
        return { text: `ack ${last}` };
      },
    });
    const run = h.session.prompt("go");
    await waitUntil(
      () =>
        h.events.some((e) => e.type === "tool_execution_update" && e.partial.includes("started")),
      5000,
    );
    expect(await h.session.steer("hurry up")).toBe("queued");
    timers.fire(0);
    await run;
    // 第二次请求：工具结果（已转后台）+ 插话都在上下文里
    const second = h.scripted.calls[1];
    expect(second).toBeDefined();
    expect(userTexts(second!.context)).toContain("hurry up");
    const toolResult = h.session.messages.find((m) => m.role === "toolResult");
    expect(String(toolResult?.content)).toContain("moved to background job bg1");
    expect(h.events.some((e) => e.type === "background_job" && e.phase === "started")).toBe(true);
    // 命令结束 → 下次提示前经提醒通道通知一次
    await (await import("node:fs/promises")).writeFile(gate, "");
    await jobsForSession(h.manager.id).wait("bg1", 5000);
    await h.session.prompt("next");
    const reminders = h.session.entries.filter(
      (e) => e.type === "custom_message" && e.customType === REMINDER_CUSTOM_TYPE,
    );
    expect(reminders).toHaveLength(1);
    expect(String(reminders[0]?.type === "custom_message" && reminders[0].content)).toContain(
      "Background job bg1 (`echo started;",
    );
    await h.session.dispose();
  });
});
