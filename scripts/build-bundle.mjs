#!/usr/bin/env node
// esbuild：src/bundle.ts → dist/bundle/ama.cjs（设计 §2、§14、D2）；
// 第二入口 src/codemode/sandbox-entry.ts → dist/bundle/ama-sandbox.cjs（codemode 子进程，设计 §5.5）。
// QuickJS 引擎（#290）：worker 入口单独编译成单文件源码、assets/quickjs/quickjs.wasm 转 base64，两者都内嵌进
// ama.cjs（`__AMA_QUICKJS_WORKER_SOURCE__` / `__AMA_QUICKJS_WASM_B64__`），发布物不需要旁路文件。
// platform node、format cjs、target node22、全部内联（零运行时依赖，任何非 node: 的外部引用都算失败）。
// `import.meta.url` 替换为 __filename 的 file URL；`__AMA_VERSION__` / `__AMA_BUNDLED__` 在此定义。
// [W6-C0] `charset: "utf8"`：中文与符号按 UTF-8 原样输出（缺省 ascii 会转成 \uXXXX，每字 6 字节）；
// Node 按 UTF-8 读源码，require 无影响（docs/history/wave6-plan.md §5.1、§5.6）。

import { chmodSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "bundle", "ama.cjs");
const sandboxOutfile = join(root, "dist", "bundle", "ama-sandbox.cjs");
const tmpSuffix = `.tmp.${process.pid}`;
const tmpOutfile = `${outfile}${tmpSuffix}`;
const tmpSandboxOutfile = `${sandboxOutfile}${tmpSuffix}`;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// QuickJS worker（内嵌字符串）、codemode 子进程入口（ama-sandbox.cjs）与 quickjs.wasm 读取互不依赖，并行跑；
// 完成后再把 worker 源码与 wasm base64 注入主入口 ama.cjs。先写 .tmp 再原子替换，避免并行跑的 release:check 读到半截文件。
const [quickjsWorker, sandboxResult, quickjsWasm] = await Promise.all([
  // QuickJS worker：自包含单文件（只引用 node: 内置模块），以字符串形式交给 `new Worker(code, { eval: true })`。
  build({
    absWorkingDir: root,
    entryPoints: [join(root, "src", "codemode", "quickjs", "worker.ts")],
    write: false,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    minify: false,
    legalComments: "none",
    charset: "utf8",
    metafile: true,
    logLevel: "warning",
  }),
  // codemode 子进程入口：权限模型只允许它读自己，所以必须是自包含的单文件（只引用 node: 内置模块）。
  build({
    absWorkingDir: root,
    entryPoints: [join(root, "src", "codemode", "sandbox-entry.ts")],
    outfile: tmpSandboxOutfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    minify: false,
    legalComments: "none",
    charset: "utf8",
    metafile: true,
    logLevel: "warning",
  }),
  readFile(join(root, "assets", "quickjs", "quickjs.wasm")),
]);
const quickjsWorkerSource = quickjsWorker.outputFiles[0].text;

const result = await build({
  absWorkingDir: root,
  entryPoints: [join(root, "src", "bundle.ts")],
  outfile: tmpOutfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  charset: "utf8",
  metafile: true,
  logLevel: "warning",
  banner: {
    js: [
      "#!/usr/bin/env node",
      'const __ama_import_meta_url = require("node:url").pathToFileURL(__filename).href;',
    ].join("\n"),
  },
  define: {
    "import.meta.url": "__ama_import_meta_url",
    __AMA_VERSION__: JSON.stringify(pkg.version),
    __AMA_BUNDLED__: "true",
    // host-side.ts 据此在 ama.cjs 同目录找子进程入口
    __AMA_SANDBOX_ENTRY__: JSON.stringify("ama-sandbox.cjs"),
    __AMA_QUICKJS_WORKER_SOURCE__: JSON.stringify(quickjsWorkerSource),
    __AMA_QUICKJS_WASM_B64__: JSON.stringify(quickjsWasm.toString("base64")),
  },
});

// 守住「全部内联」：输入只能来自 src/，外部引用只能是 node: 内置模块。
const problems = [];
for (const { metafile } of [result, sandboxResult, quickjsWorker]) {
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.startsWith("src/")) problems.push(`非 src 输入被打进 bundle：${input}`);
  }
  for (const output of Object.values(metafile.outputs)) {
    for (const imp of output.imports ?? []) {
      if (imp.external && !imp.path.startsWith("node:")) {
        problems.push(`外部引用：${imp.path}（只允许 node: 内置模块）`);
      }
    }
  }
}
// 子进程入口只能读自己：除 sandbox-entry.ts（与只含类型的 protocol.ts）外不许有其它 src 输入。
for (const input of Object.keys(sandboxResult.metafile.inputs)) {
  if (input !== "src/codemode/sandbox-entry.ts") {
    problems.push(`ama-sandbox.cjs 不应包含 ${input}（子进程入口必须自包含）`);
  }
}
for (const input of Object.keys(quickjsWorker.metafile.inputs)) {
  if (input !== "src/codemode/quickjs/worker.ts") {
    problems.push(`QuickJS worker 不应包含 ${input}（worker 入口必须自包含）`);
  }
}
if (problems.length > 0) {
  rmSync(tmpOutfile, { force: true });
  rmSync(tmpSandboxOutfile, { force: true });
  for (const p of problems) console.error(`build-bundle: ${p}`);
  process.exit(1);
}

chmodSync(tmpOutfile, 0o755);
renameSync(tmpSandboxOutfile, sandboxOutfile);
renameSync(tmpOutfile, outfile);
for (const file of [outfile, sandboxOutfile]) {
  const size = statSync(file).size;
  console.log(`build-bundle: ${relative(root, file)} ${(size / 1024).toFixed(1)} KiB`);
}
