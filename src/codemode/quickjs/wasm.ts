/**
 * QuickJS 引擎的资源定位：编译好的 `WebAssembly.Module`（进程内缓存，传给每个 worker）与 worker 入口。[#290]
 *
 * - bundle（ama.cjs）：构建脚本把 wasm 的 base64 与 worker 的单文件源码定义成 `__AMA_QUICKJS_WASM_B64__` /
 *   `__AMA_QUICKJS_WORKER_SOURCE__`，运行时不需要任何旁路文件；
 * - tsc 产物与源码树：`assets/quickjs/quickjs.wasm`（相对本文件三级目录上去，npm 包的 `files` 带着它）
 *   与同目录的 `worker.js` / `worker.ts`。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const __AMA_QUICKJS_WASM_B64__: string | undefined;
declare const __AMA_QUICKJS_WORKER_SOURCE__: string | undefined;

let compiled: Promise<WebAssembly.Module> | undefined;

/** wasm 字节：bundle 内嵌，否则读 assets 目录。 */
export function readQuickjsWasm(moduleUrl: string = import.meta.url): Buffer {
  if (typeof __AMA_QUICKJS_WASM_B64__ !== "undefined") {
    return Buffer.from(__AMA_QUICKJS_WASM_B64__, "base64");
  }
  const here = dirname(fileURLToPath(moduleUrl));
  return readFileSync(join(here, "..", "..", "..", "assets", "quickjs", "quickjs.wasm"));
}

/** 编译一次，之后每个 worker 复用（`WebAssembly.Module` 可经 workerData 结构化克隆）。 */
export function quickjsModule(): Promise<WebAssembly.Module> {
  compiled ??= WebAssembly.compile(readQuickjsWasm()).catch((error: unknown) => {
    compiled = undefined;
    throw error;
  });
  return compiled;
}

/** worker 的启动方式：bundle 里是内嵌源码（eval worker），否则是文件。 */
export type WorkerSource = { eval: true; code: string } | { eval: false; file: URL };

export function resolveQuickjsWorker(moduleUrl: string = import.meta.url): WorkerSource {
  if (typeof __AMA_QUICKJS_WORKER_SOURCE__ !== "undefined") {
    return { eval: true, code: __AMA_QUICKJS_WORKER_SOURCE__ };
  }
  const here = dirname(fileURLToPath(moduleUrl));
  for (const name of ["worker.js", "worker.ts"]) {
    if (existsSync(join(here, name))) return { eval: false, file: new URL(name, moduleUrl) };
  }
  throw new Error("codemode QuickJS worker not found (build the package first)");
}
