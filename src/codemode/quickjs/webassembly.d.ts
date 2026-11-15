/** 最小的 WebAssembly 全局声明（tsconfig 的 lib 不含 DOM，@types/node 也不带它）。 */
declare namespace WebAssembly {
  class Module {}
  class RuntimeError extends Error {}
  class Memory {
    readonly buffer: ArrayBuffer;
  }
  class Instance {
    constructor(module: Module, imports?: Record<string, Record<string, unknown>>);
    readonly exports: Record<string, unknown>;
  }
  function compile(bytes: Uint8Array): Promise<Module>;
}
