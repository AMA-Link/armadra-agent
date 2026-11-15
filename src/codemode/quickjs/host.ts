/**
 * codemode 的 QuickJS 引擎：主线程一侧（设计 §5.5）。[#290]
 *
 * 与 `runSandbox`（Node 子进程引擎）同一个请求 / 结果形状，tool.ts 按引擎二选一：每次执行起一个
 * worker 线程（worker.ts），脚本跑在 WebAssembly 里的 QuickJS 中，只能经 `tools.*` 触达外界。
 *
 * - `tool_call` → `callTool`（完整门禁，同 host-side.ts）；`codemode` 自己直接拒绝；
 * - 超时 / 外层 abort：先写共享的中断标志（QuickJS 的中断处理器读它，空转的脚本会被打断），再 `abort`
 *   消息（脚本在等工具结果时用），宽限后 `worker.terminate()`；结束后一律 terminate；
 * - 内存：`codemode.maxHeapMb`（缺省 256）→ QuickJS 的内存上限；超出时脚本抛 out of memory，映射成与
 *   Node 引擎相同的文案；
 * - worker 崩溃 / 非预期退出 → 失败结果，不影响宿主。
 */

import { Worker } from "node:worker_threads";
import {
  BOOTSTRAP,
  MAX_CONCURRENT,
  MAX_STORE_TOTAL_CHARS,
  MAX_STORE_VALUE_CHARS,
} from "../sandbox-entry.js";
import {
  ABORT_GRACE_MS,
  DEFAULT_CODEMODE_HEAP_MB,
  MAX_COLLECTED_OUTPUT_CHARS,
  heapLimitError,
  type SandboxRunRequest,
  type SandboxRunResult,
} from "../host-side.js";
import { MAX_SCRIPT_IMAGES, SEARCH_TOOLS_CALL, type ChildMessage } from "../protocol.js";
import { DEFAULT_MAX_WORKERS, MAX_WORKER_WAIT_MS, codemodeWorkerPool } from "../worker-pool.js";
import { quickjsModule, resolveQuickjsWorker } from "./wasm.js";
import type { QuickjsWorkerData, WorkerInMessage } from "./worker.js";

const realTimers = {
  set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clear: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export async function runQuickjs(request: SandboxRunRequest): Promise<SandboxRunResult> {
  const started = Date.now();
  const heapMb = Math.floor(request.maxHeapMb ?? DEFAULT_CODEMODE_HEAP_MB);
  const result: SandboxRunResult = {
    ok: false,
    outputs: [],
    images: [],
    timedOut: false,
    aborted: false,
    toolCalls: 0,
    droppedChars: 0,
    elapsedMs: 0,
  };
  if (request.signal.aborted) {
    return { ...result, error: "Script aborted", aborted: true };
  }
  // 进程级名额（与 Node 引擎共用同一个池）：排队 ≤ 60 s 且计入 timeout_ms；名额在 worker 真正退出时归还
  const timeoutMs = request.options.timeoutMs;
  const limit = request.maxWorkers ?? DEFAULT_MAX_WORKERS;
  const slot = await (request.workerPool ?? codemodeWorkerPool).acquire({
    limit,
    waitMs: Math.min(MAX_WORKER_WAIT_MS, timeoutMs),
    signal: request.signal,
  });
  if (slot.status === "aborted") {
    return { ...result, error: "Script aborted", aborted: true };
  }
  if (slot.status === "timeout") {
    const ownDeadline = timeoutMs <= MAX_WORKER_WAIT_MS;
    return {
      ...result,
      timedOut: ownDeadline,
      error: ownDeadline
        ? `Script timed out after ${timeoutMs} ms waiting for a free codemode sandbox slot (${slot.active} of ${limit} in use); it was not run`
        : `Script was not run: all ${limit} codemode sandbox slots stayed busy for ${MAX_WORKER_WAIT_MS / 1000} s; try again when other scripts finish`,
      elapsedMs: slot.waitedMs,
    };
  }
  const lease = slot.lease;
  const runTimeoutMs = Math.max(1, timeoutMs - slot.waitedMs);

  let module: WebAssembly.Module;
  let source: ReturnType<typeof resolveQuickjsWorker>;
  try {
    module = await quickjsModule();
    source = resolveQuickjsWorker();
  } catch (error) {
    lease.release();
    return { ...result, error: `Failed to start codemode sandbox: ${(error as Error).message}` };
  }

  const flag = new SharedArrayBuffer(4);
  const flagView = new Int32Array(flag);
  const data: QuickjsWorkerData = {
    module,
    bootstrap: BOOTSTRAP,
    script: request.script,
    tools: request.tools,
    store: request.store,
    limits: {
      maxConcurrent: MAX_CONCURRENT,
      maxValueChars: MAX_STORE_VALUE_CHARS,
      maxTotalChars: MAX_STORE_TOTAL_CHARS,
      maxImages: MAX_SCRIPT_IMAGES,
    },
    memoryLimitBytes: heapMb > 0 ? heapMb * 1024 * 1024 : 0,
    flag,
  };
  // execArgv 清空：不继承宿主的 --input-type / --inspect 等只对主线程有意义的开关
  const options = { workerData: data, env: {}, execArgv: [], name: "codemode-quickjs" };
  let worker: Worker;
  try {
    worker = source.eval
      ? new Worker(source.code, { ...options, eval: true })
      : new Worker(source.file, options);
  } catch (error) {
    lease.release();
    return { ...result, error: `Failed to start codemode sandbox: ${(error as Error).message}` };
  }

  const calls = new AbortController();
  let collected = 0;
  let settled = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const send = (message: WorkerInMessage): void => {
    if (!settled) worker.postMessage(message);
  };
  const settle = (patch: Partial<SandboxRunResult>): void => {
    if (settled) return;
    settled = true;
    Object.assign(result, patch);
    result.elapsedMs = patch.elapsedMs ?? Date.now() - started;
    calls.abort();
    finish();
  };
  /** 先拉中断标志（空转的脚本据此停下），随后由收尾的 terminate 兜底。 */
  const interrupt = (): void => {
    Atomics.store(flagView, 0, 1);
  };

  const timers = request.timeoutTimers ?? realTimers;
  const timer = timers.set(() => {
    interrupt();
    settle({
      ok: false,
      timedOut: true,
      error: `Script timed out after ${timeoutMs} ms`,
    });
  }, runTimeoutMs);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    interrupt();
    send({ type: "abort" });
    graceTimer = setTimeout(
      () => settle({ ok: false, aborted: true, error: "Script aborted" }),
      ABORT_GRACE_MS,
    );
  };
  request.signal.addEventListener("abort", onAbort, { once: true });

  worker.on("message", (message: ChildMessage) => {
    if (settled) return;
    switch (message.type) {
      case "output": {
        const text = message.text;
        if (collected + text.length > MAX_COLLECTED_OUTPUT_CHARS) {
          result.droppedChars += text.length;
          return;
        }
        collected += text.length;
        result.outputs.push(text);
        request.onOutput?.(text);
        return;
      }
      case "image":
        if (
          typeof message.data === "string" &&
          typeof message.mimeType === "string" &&
          result.images.length < MAX_SCRIPT_IMAGES
        ) {
          result.images.push({ data: message.data, mimeType: message.mimeType });
        }
        return;
      case "tool_call": {
        const { id, name, input } = message;
        if (name === SEARCH_TOOLS_CALL) {
          const args = (input ?? {}) as { query?: unknown; options?: unknown };
          try {
            const value = request.searchTools?.(args.query, args.options) ?? [];
            send({ type: "tool_result", id, ok: true, json: JSON.stringify(value) });
          } catch (error) {
            send({
              type: "tool_result",
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }
        result.toolCalls++;
        if (name === "codemode") {
          send({
            type: "tool_result",
            id,
            ok: false,
            error: "codemode cannot be called from a codemode script",
          });
          return;
        }
        request.callTool(name, input, calls.signal).then(
          (value) => {
            let json: string | undefined;
            try {
              json = JSON.stringify(value ?? null);
            } catch (error) {
              send({ type: "tool_result", id, ok: false, error: (error as Error).message });
              return;
            }
            send({ type: "tool_result", id, ok: true, json });
          },
          (error: unknown) =>
            send({
              type: "tool_result",
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
        return;
      }
      case "store":
        result.store = message.entries;
        return;
      case "done": {
        const patch: Partial<SandboxRunResult> = { ok: message.ok, elapsedMs: message.elapsedMs };
        if (message.error !== undefined) {
          patch.error =
            heapMb > 0 && /^InternalError: out of memory/i.test(message.error)
              ? heapLimitError(heapMb)
              : message.error;
        }
        if (request.signal.aborted) {
          patch.ok = false;
          patch.aborted = true;
        }
        if (patch.ok !== true) delete result.store;
        settle(patch);
        return;
      }
    }
  });
  worker.on("error", (error) =>
    settle({ ok: false, error: `codemode QuickJS engine crashed: ${error.message}` }),
  );
  worker.on("exit", (code) => {
    lease.release();
    settle({ ok: false, error: `codemode QuickJS engine exited unexpectedly (code ${code})` });
  });

  await finished;
  timers.clear(timer);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  request.signal.removeEventListener("abort", onAbort);
  void worker.terminate();
  return result;
}
