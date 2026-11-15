/**
 * codemode 的 QuickJS 引擎：worker 线程入口（设计 §5.5）。[#290]
 *
 * 每次执行一个 worker：用主线程编译好的 `WebAssembly.Module` 实例化 QuickJS（WASI reactor），在 VM 里
 * 先冻结内建对象，再跑与 Node 引擎同一份引导脚本（`BOOTSTRAP`，由主线程经 `workerData` 传入），最后跑
 * 模型写的脚本。VM 里没有 require / process / fetch / 定时器：它与外界只有一个宿主函数 `host(kind,
 * payload)`，WASI 只给时钟、随机数与丢弃的 stdout / stderr。
 *
 * - 主线程 ↔ worker 的消息沿用 protocol.ts 的 `ChildMessage` 形状（`tool_call` / `output` / `store` /
 *   `done`），反向是 `tool_result`（值已是 JSON 字符串）与 `abort`；
 * - 中断：QuickJS 的中断处理器读 `SharedArrayBuffer` 里的一个标志位；Promise 任务一件一件执行，每 64
 *   件再读一次标志，所以 `while (true) await null` 这类不经过解释器轮询点的循环也能停下；
 * - 内存：`qjs_set_memory_limit`；栈溢出以宿主 RangeError 的形式冒出来，此时 VM 不再可用，直接以失败结束；
 * - 脚本等待一个永远不会落定的 Promise（没有未完成的工具调用）时立即失败，不拖到超时。
 *
 * 本文件**只能 import node: 内置模块与类型**：源码树里它被 Node 直接剥离类型运行（不经构建），打进
 * ama.cjs 时由 build-bundle.mjs 单独编译成字符串内嵌；所以不依赖任何其它源文件的运行时代码。
 */

import { randomFillSync } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import type { ChildMessage, ToolDecl } from "../protocol.js";

/** 主线程经 `workerData` 传入的启动参数。 */
export interface QuickjsWorkerData {
  module: WebAssembly.Module;
  /** 与 Node 引擎共用的引导脚本源码（sandbox-entry.ts 的 BOOTSTRAP）。 */
  bootstrap: string;
  script: string;
  tools: ToolDecl[];
  store: Record<string, unknown>;
  /** 引导脚本的配置：并发上限与 store 上限。 */
  limits: { maxConcurrent: number; maxValueChars: number; maxTotalChars: number };
  /** QuickJS 内存上限（字节）；0 不设上限。 */
  memoryLimitBytes: number;
  /** 4 字节的中断标志：非 0 表示该停了。 */
  flag: SharedArrayBuffer;
}

/** worker → 主线程的消息：ChildMessage（含 done）。 */
export type WorkerOutMessage = ChildMessage;
/** 主线程 → worker。 */
export type WorkerInMessage =
  | { type: "tool_result"; id: number; ok: true; json: string | undefined }
  | { type: "tool_result"; id: number; ok: false; error: string }
  | { type: "abort" };

const SCRIPT_FILENAME = "codemode-script.js";
const BOOTSTRAP_FILENAME = "codemode-bootstrap.js";
const JOBS_PER_POLL = 64;

/** 先于引导脚本执行：冻结所有内建对象（Error 原型除外：子类里 `this.name = ...` 要能赋值）。 */
const FREEZE_SOURCE = String.raw`(function () {
  "use strict";
  const seen = new Set();
  const keep = new Set([
    Error.prototype, EvalError.prototype, RangeError.prototype, ReferenceError.prototype,
    SyntaxError.prototype, TypeError.prototype, URIError.prototype, InternalError.prototype,
    AggregateError.prototype, DOMException.prototype,
  ]);
  const root = globalThis;
  function visit(value) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const desc = Reflect.getOwnPropertyDescriptor(value, key);
      if (desc === undefined) continue;
      if ("value" in desc) visit(desc.value);
      else { visit(desc.get); visit(desc.set); }
    }
    visit(Reflect.getPrototypeOf(value));
    if (value !== root && !keep.has(value)) Object.freeze(value);
  }
  visit(root);
  for (const sample of [async function () {}, function* () {}, async function* () {}, [][Symbol.iterator](),
    new Map()[Symbol.iterator](), new Set()[Symbol.iterator](), ""[Symbol.iterator](), /x/[Symbol.matchAll]("x")]) {
    visit(Reflect.getPrototypeOf(sample));
  }
  visit(Reflect.getPrototypeOf(Int8Array));
})`;

/** 跑在 VM 里的收尾层：引导脚本的 `run` 落定后经宿主函数报告，错误描述带脚本行号。 */
const DRIVER_SOURCE = String.raw`(function (factory, host, config) {
  "use strict";
  const bridge = factory(host, config);
  const describe = (e) => {
    if (typeof e !== "object" || e === null) return String(e);
    const base = typeof e.message === "string"
      ? (typeof e.name === "string" ? e.name : "Error") + ": " + e.message
      : String(e);
    const stack = typeof e.stack === "string" ? e.stack : "";
    const at = /codemode-script\.js:(\d+)/.exec(stack);
    return at === null ? base : base + " (line " + at[1] + ")";
  };
  return {
    deliver: bridge.deliver,
    finish: bridge.finish,
    start: (main) => {
      bridge.run(main).then(() => host("done", ""), (e) => host("fail", describe(e)));
    },
  };
})`;

interface QjsExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  qjs_init(): number;
  qjs_set_memory_limit(bytes: number): void;
  qjs_set_interrupt_handler(enable: number): void;
  qjs_get_undefined(): number;
  qjs_get_true(): number;
  qjs_get_false(): number;
  qjs_get_global(): number;
  qjs_new_string(ptr: number, len: number): number;
  qjs_new_number(value: number): number;
  qjs_new_host_function(namePtr: number, nameLen: number, magic: number): number;
  qjs_get_prop_string(obj: number, namePtr: number): number;
  qjs_set_prop_string(obj: number, namePtr: number, value: number): number;
  qjs_eval(codePtr: number, len: number, filenamePtr: number, flags: number): number;
  qjs_call(fn: number, thisArg: number, argc: number, argvPtr: number): number;
  qjs_is_exception(box: number): number;
  qjs_is_uncatchable_error(box: number): number;
  qjs_is_undefined(box: number): number;
  qjs_is_object(box: number): number;
  qjs_get_exception(): number;
  qjs_get_string_len(box: number, lenPtr: number): number;
  qjs_free_cstring(ptr: number): void;
  qjs_free_value(box: number): void;
  qjs_dup_value(box: number): number;
  qjs_is_job_pending(): number;
  qjs_execute_pending_job(): number;
  wasm_malloc(size: number): number;
  wasm_free(ptr: number): void;
}

/** 单个脚本最多附几张图（与 sandbox-entry.ts 的 MAX_SCRIPT_IMAGES 一致；本文件不能 import 它）。 */
const MAX_SCRIPT_IMAGES = 8;

/** 按文件头认 PNG / JPEG / GIF / WebP（与 sandbox-entry.ts 的 sniffImage 逐行一致）。 */
function sniffImage(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a)
    return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("ascii", 0, 6))) return "image/gif";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return undefined;
}

/** `image()` 的入参 → `{ data, mimeType }`；不合法返回错误文本（与 sandbox-entry.ts 的 normalizeImage 一致）。 */
function normalizeImage(value: unknown): { data: string; mimeType: string } | string {
  let raw: unknown = value;
  if (typeof raw === "object" && raw !== null) {
    const o = raw as { type?: unknown; data?: unknown; image_url?: unknown };
    if (o.type === "image" && typeof o.data === "string") raw = o.data;
    else if (typeof o.image_url === "string") raw = o.image_url;
    else if (
      typeof o.image_url === "object" &&
      o.image_url !== null &&
      typeof (o.image_url as { url?: unknown }).url === "string"
    )
      raw = (o.image_url as { url: string }).url;
  }
  if (typeof raw !== "string") {
    return "image(value): pass a base64 data: URL, { image_url }, or { type: 'image', data, mimeType }";
  }
  let base64 = raw.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(base64)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== "data") {
    return "image(value): remote URLs are not supported; pass a base64 data: URL";
  }
  if (scheme === "data") {
    const match = /^data:[^,]*;base64,([\s\S]*)$/i.exec(base64);
    if (match === null) return "image(value): the data: URL must be base64-encoded";
    base64 = (match[1] ?? "").trim();
  }
  base64 = base64.replace(/\s+/g, "");
  if (base64 === "" || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    return "image(value): the image data is not valid base64";
  }
  const mimeType = sniffImage(Buffer.from(base64, "base64"));
  if (mimeType === undefined) return "image(value): not a PNG, JPEG, GIF or WebP image";
  return { data: base64, mimeType };
}

/** VM 里的脚本以失败结束（语法错误、未捕获的异常、被中断）。 */
class ScriptFailure extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** QuickJS 实例：句柄是 wasm 堆上的 JSValue 盒子，调用方负责 `free`。 */
class Vm {
  readonly x: QjsExports;
  private readonly flag: Int32Array;
  readonly undef: number;
  readonly yes: number;
  readonly no: number;
  hostHandler: (kind: string, payload: string) => string | undefined = () => undefined;

  constructor(module: WebAssembly.Module, flag: Int32Array, memoryLimitBytes: number) {
    this.flag = flag;
    let memory: WebAssembly.Memory | undefined;
    const mem = (): WebAssembly.Memory => memory as WebAssembly.Memory;
    const instance = new WebAssembly.Instance(module, {
      env: {
        host_call: (namePtr: number, nameLen: number, _this: number, argc: number, argv: number) =>
          this.onHostCall(namePtr, nameLen, argc, argv),
        host_interrupt: () => (Atomics.load(this.flag, 0) !== 0 ? 1 : 0),
        host_promise_rejection: () => {},
        host_module_normalize: () => 0,
        host_module_load: () => 0,
        host_get_timezone_offset: (hi: number, lo: number) =>
          -new Date(Number((BigInt(hi) << 32n) | BigInt(lo >>> 0)) * 1000).getTimezoneOffset() * 60,
      },
      wasi_snapshot_preview1: {
        clock_time_get: (_id: number, _precision: bigint, out: number) => {
          new DataView(mem().buffer).setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true);
          return 0;
        },
        // stdout / stderr 丢弃：引擎的内部日志不该出现在宿主终端里
        fd_write: (_fd: number, iovs: number, iovsLen: number, written: number) => {
          const view = new DataView(mem().buffer);
          let total = 0;
          for (let i = 0; i < iovsLen; i++) total += view.getUint32(iovs + i * 8 + 4, true);
          view.setUint32(written, total, true);
          return 0;
        },
        fd_close: () => 0,
        fd_fdstat_get: (fd: number, out: number) => {
          if (fd > 2) return 8;
          new Uint8Array(mem().buffer, out, 24).fill(0);
          new Uint8Array(mem().buffer)[out] = 2;
          return 0;
        },
        fd_seek: () => 70,
        random_get: (ptr: number, len: number) => {
          randomFillSync(new Uint8Array(mem().buffer, ptr, len));
          return 0;
        },
      },
    });
    const x = instance.exports as unknown as QjsExports;
    memory = x.memory;
    this.x = x;
    x._initialize();
    if (x.qjs_init() !== 0) throw new Error("Failed to initialize QuickJS");
    if (memoryLimitBytes > 0) x.qjs_set_memory_limit(memoryLimitBytes);
    x.qjs_set_interrupt_handler(1);
    this.undef = x.qjs_get_undefined();
    this.yes = x.qjs_get_true();
    this.no = x.qjs_get_false();
  }

  private onHostCall(_namePtr: number, _nameLen: number, argc: number, argv: number): number {
    const args: string[] = [];
    const view = new DataView(this.x.memory.buffer);
    for (let i = 0; i < Math.min(argc, 2); i++)
      args.push(this.text(view.getUint32(argv + i * 4, true)));
    const reply = this.hostHandler(args[0] ?? "", args[1] ?? "");
    return reply === undefined ? this.x.qjs_dup_value(this.undef) : this.str(reply);
  }

  /** 把字符串写进 wasm 堆（NUL 结尾）。 */
  put(text: string): { ptr: number; len: number } {
    const bytes = encoder.encode(text);
    const ptr = this.x.wasm_malloc(bytes.length + 1);
    if (ptr === 0) throw new Error("wasm_malloc failed");
    const heap = new Uint8Array(this.x.memory.buffer);
    heap.set(bytes, ptr);
    heap[ptr + bytes.length] = 0;
    return { ptr, len: bytes.length };
  }

  /** 任意值转字符串（对象会触发 toString）。 */
  text(box: number): string {
    const lenPtr = this.x.wasm_malloc(4);
    try {
      const cstr = this.x.qjs_get_string_len(box, lenPtr);
      if (cstr === 0) return "";
      const len = new DataView(this.x.memory.buffer).getUint32(lenPtr, true);
      const out = decoder.decode(new Uint8Array(this.x.memory.buffer, cstr, len));
      this.x.qjs_free_cstring(cstr);
      return out;
    } finally {
      this.x.wasm_free(lenPtr);
    }
  }

  str(text: string): number {
    const { ptr, len } = this.put(text);
    try {
      return this.x.qjs_new_string(ptr, len);
    } finally {
      this.x.wasm_free(ptr);
    }
  }

  prop(obj: number, name: string): number {
    const { ptr } = this.put(name);
    try {
      return this.x.qjs_get_prop_string(obj, ptr);
    } finally {
      this.x.wasm_free(ptr);
    }
  }

  free(...boxes: number[]): void {
    for (const box of boxes) this.x.qjs_free_value(box);
  }

  /** 取出当前异常并描述成 `Name: message (line N)`；被中断 → 固定文案。 */
  private takeFailure(): ScriptFailure {
    const box = this.x.qjs_get_exception();
    try {
      if (this.x.qjs_is_uncatchable_error(box) !== 0) {
        // 中断标志没拉而引擎抛出不可捕获的错误：内存上限
        return new ScriptFailure(
          Atomics.load(this.flag, 0) !== 0 ? "Script interrupted" : "InternalError: out of memory",
        );
      }
      if (this.x.qjs_is_object(box) === 0) return new ScriptFailure(this.text(box));
      const field = (name: string): string | undefined => {
        const value = this.prop(box, name);
        try {
          return this.x.qjs_is_undefined(value) !== 0 ? undefined : this.text(value);
        } finally {
          this.free(value);
        }
      };
      const message = field("message");
      const base =
        message === undefined ? this.text(box) : `${field("name") ?? "Error"}: ${message}`;
      const at = /codemode-script\.js:(\d+)/.exec(field("stack") ?? "");
      return new ScriptFailure(at === null ? base : `${base} (line ${at[1]})`);
    } finally {
      this.free(box);
    }
  }

  /** 求值；抛出的异常变成 ScriptFailure。 */
  evalCode(code: string, filename: string): number {
    const source = this.put(code);
    const name = this.put(filename);
    try {
      const result = this.x.qjs_eval(source.ptr, source.len, name.ptr, 0);
      if (this.x.qjs_is_exception(result) === 0) return result;
      this.free(result);
      throw this.takeFailure();
    } finally {
      this.x.wasm_free(source.ptr);
      this.x.wasm_free(name.ptr);
    }
  }

  /** 调用函数；`args` 里的盒子由调用方释放。 */
  call(fn: number, thisArg: number, args: number[]): number {
    const argv = args.length === 0 ? 0 : this.x.wasm_malloc(args.length * 4);
    if (args.length > 0) {
      const view = new DataView(this.x.memory.buffer);
      args.forEach((box, i) => view.setUint32(argv + i * 4, box, true));
    }
    try {
      const result = this.x.qjs_call(fn, thisArg, args.length, argv);
      if (this.x.qjs_is_exception(result) === 0) return result;
      this.free(result);
      throw this.takeFailure();
    } finally {
      if (argv !== 0) this.x.wasm_free(argv);
    }
  }

  /** 把全局属性 `name` 设为宿主函数（注册名 `host`）。 */
  newHostFunction(name: string): number {
    const { ptr, len } = this.put(name);
    try {
      return this.x.qjs_new_host_function(ptr, len, 0);
    } finally {
      this.x.wasm_free(ptr);
    }
  }

  /** 逐个执行待处理的 Promise 任务；周期性读中断标志。返回前 `stop()` 为真则提前结束。 */
  drain(stop: () => boolean): void {
    let jobs = 0;
    while (!stop() && this.x.qjs_is_job_pending() !== 0) {
      if (this.x.qjs_execute_pending_job() < 0) throw this.takeFailure();
      if (++jobs % JOBS_PER_POLL === 0 && Atomics.load(this.flag, 0) !== 0) {
        throw new ScriptFailure("Script interrupted");
      }
    }
  }
}

function post(message: WorkerOutMessage): void {
  (parentPort as NonNullable<typeof parentPort>).postMessage(message);
}

function run(data: QuickjsWorkerData): void {
  const started = Date.now();
  let finished = false;
  let outstanding = 0;
  let images = 0;
  let failure: string | undefined;
  let vm: Vm | undefined;
  let driver: { deliver: number; finish: number; start: number } | undefined;

  const conclude = (ok: boolean, error?: string): void => {
    if (finished && driver === undefined) return;
    finished = true;
    if (vm !== undefined && driver !== undefined) {
      const current = driver;
      driver = undefined;
      try {
        const snapshot = vm.call(current.finish, vm.undef, []);
        try {
          if (ok && vm.x.qjs_is_undefined(snapshot) === 0) {
            post({
              type: "store",
              entries: JSON.parse(vm.text(snapshot)) as Record<string, unknown>,
            });
          }
        } finally {
          vm.free(snapshot);
        }
      } catch {
        // VM 已不可用（栈溢出、被中断）：没有 store 可交
      }
    }
    const message: WorkerOutMessage = { type: "done", ok, elapsedMs: Date.now() - started };
    if (error !== undefined) message.error = error;
    post(message);
  };

  /** 排空 Promise 任务；脚本没结束又没有未完成的工具调用 → 它不可能再前进。 */
  const pump = (): void => {
    const machine = vm as Vm;
    machine.drain(() => finished);
    if (failure !== undefined) conclude(false, failure);
    else if (finished) conclude(true);
    else if (outstanding === 0) {
      conclude(false, "Script awaited a promise that can never settle (no tool call is pending)");
    }
  };

  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      conclude(false, describeHostError(error));
    }
  };

  guard(() => {
    vm = new Vm(data.module, new Int32Array(data.flag), data.memoryLimitBytes);
    const machine = vm;
    machine.hostHandler = (kind, payload) => {
      if (finished) return undefined;
      if (kind === "image") {
        // 返回字符串 = 校验失败的原因，引导脚本据此抛 TypeError
        if (images >= MAX_SCRIPT_IMAGES) {
          return `image(value): at most ${MAX_SCRIPT_IMAGES} images per script`;
        }
        const normalized = normalizeImage((JSON.parse(payload) as { value?: unknown }).value);
        if (typeof normalized === "string") return normalized;
        images++;
        post({ type: "image", data: normalized.data, mimeType: normalized.mimeType });
      } else if (kind === "output") {
        post({ type: "output", text: payload });
      } else if (kind === "tool_call") {
        const newline = payload.indexOf("\n");
        const call = JSON.parse(payload.slice(newline + 1)) as { name: string; input: unknown };
        outstanding++;
        post({
          type: "tool_call",
          id: Number(payload.slice(0, newline)),
          name: call.name,
          input: call.input,
        });
      } else if (kind === "done") {
        finished = true;
      } else if (kind === "fail") {
        finished = true;
        failure = payload;
      }
      return undefined;
    };
    machine.free(
      machine.call(machine.evalCode(FREEZE_SOURCE, "codemode-freeze.js"), machine.undef, []),
    );
    const factory = machine.evalCode(data.bootstrap, BOOTSTRAP_FILENAME);
    const host = machine.newHostFunction("host");
    const config = machine.evalCode(
      `(${JSON.stringify({
        maxConcurrent: data.limits.maxConcurrent,
        maxValueChars: data.limits.maxValueChars,
        maxTotalChars: data.limits.maxTotalChars,
        tools: JSON.stringify(data.tools),
        store: JSON.stringify(data.store),
      })})`,
      BOOTSTRAP_FILENAME,
    );
    const make = machine.evalCode(DRIVER_SOURCE, "codemode-driver.js");
    const made = machine.call(make, machine.undef, [factory, host, config]);
    driver = {
      deliver: machine.prop(made, "deliver"),
      finish: machine.prop(made, "finish"),
      start: machine.prop(made, "start"),
    };
    machine.free(made, make, config, host, factory);
    // 前缀与脚本首行同一行，报告的行号与脚本一致
    const main = machine.evalCode(`(async () => {${data.script}\n})()`, SCRIPT_FILENAME);
    machine.free(machine.call(driver.start, machine.undef, [main]));
    machine.free(main);
    pump();
  });

  (parentPort as NonNullable<typeof parentPort>).on("message", (message: WorkerInMessage) => {
    if (finished) return;
    if (message.type === "abort") {
      conclude(false, "Script aborted");
      return;
    }
    guard(() => {
      const machine = vm as Vm;
      const current = driver;
      if (current === undefined) return;
      outstanding--;
      const id = machine.x.qjs_new_number(message.id);
      const ok = message.ok ? machine.yes : machine.no;
      const payload = message.ok ? message.json : message.error;
      const arg = payload === undefined ? machine.undef : machine.str(payload);
      try {
        machine.free(machine.call(current.deliver, machine.undef, [id, ok, arg]));
      } finally {
        machine.free(id);
        if (payload !== undefined) machine.free(arg);
      }
      pump();
    });
  });
}

/** 宿主侧异常（栈溢出、wasm 陷阱、内存增长失败）的说明。 */
function describeHostError(error: unknown): string {
  if (error instanceof ScriptFailure) return error.message;
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (error instanceof RangeError && /call stack/i.test(error.message)) {
    return "RangeError: Maximum call stack size exceeded";
  }
  if (error instanceof WebAssembly.RuntimeError) {
    // QuickJS 在 WASI 上没有栈上限检查：无界递归把 wasm 栈写穿，表现为越界陷阱
    return `Script crashed the QuickJS engine (likely unbounded recursion): ${text}`;
  }
  return `codemode QuickJS engine failed: ${text}`;
}

if (parentPort !== null && workerData !== null && typeof workerData === "object") {
  run(workerData as QuickjsWorkerData);
}
