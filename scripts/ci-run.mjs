#!/usr/bin/env node
/**
 * 并行 CI 编排（`pnpm run ci` 入口）：
 *
 * - 阶段 1（并行）：`typecheck`、`fmt:check`、`check:deps`、`check:i18n`、`check:docs`、
 *   `check:portability`、`release:check`、`build:lib`（写 `dist/*.js` + `*.d.ts`）、
 *   `build:bundle`（写 `dist/bundle/*.cjs`）。
 * - 阶段 2：bundle 冒烟（`node dist/bundle/ama.cjs --version`）。
 * - 阶段 3：Vitest。缺省与历史 `pnpm run ci` 一致只跑单测；传 `--with-e2e`（CI 矩阵使用）时
 *   带 `AMA_E2E=1` 一次跑完单测与 `test/e2e`，共享一次 Vitest `forks` 进程池启动。
 * - `--skip-repo-statics`：跳过与平台 / Node 版本无关的全仓静态检查（`fmt:check`、`check:deps`、
 *   `check:i18n`、`check:docs`），供 CI 矩阵的非主行去重；`typecheck`、`check:portability`、
 *   `release:check`、构建、冒烟与测试仍在每一行完整执行。
 */

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

const PRETTIER_ARGS = [
  "exec",
  "prettier",
  "--check",
  "--cache",
  "--cache-location",
  "node_modules/.cache/prettier/.prettier-cache",
  ".",
];

/**
 * 解析命令行参数。
 * @param {readonly string[]} argv
 * @returns {{ withE2e: boolean, skipRepoStatics: boolean }}
 */
export function parseCliArgs(argv) {
  let withE2e = false;
  let skipRepoStatics = false;
  for (const arg of argv) {
    if (arg === "--with-e2e") withE2e = true;
    else if (arg === "--skip-repo-statics") skipRepoStatics = true;
    else throw new Error(`未知参数：${arg}（可选：--with-e2e、--skip-repo-statics）`);
  }
  return { withE2e, skipRepoStatics };
}

/**
 * 生成三阶段执行计划。
 * @param {{ withE2e?: boolean, skipRepoStatics?: boolean }} [options]
 */
export function buildCiPlan(options = {}) {
  const { withE2e = false, skipRepoStatics = false } = options;
  const repoStatics = skipRepoStatics
    ? []
    : [
        { id: "fmt:check", command: "pnpm", args: PRETTIER_ARGS },
        { id: "check:deps", command: "node", args: ["scripts/check-no-deps.mjs"] },
        { id: "check:i18n", command: "node", args: ["scripts/check-i18n.mjs"] },
        { id: "check:docs", command: "node", args: ["scripts/check-doc-links.mjs"] },
      ];
  const phase1 = [
    { id: "typecheck", command: "pnpm", args: ["exec", "tsc", "--noEmit"] },
    ...repoStatics,
    { id: "check:portability", command: "node", args: ["scripts/check-portability.mjs"] },
    { id: "release:check", command: "node", args: ["scripts/release-check.mjs"] },
    { id: "build:lib", command: "pnpm", args: ["exec", "tsc", "-p", "tsconfig.build.json"] },
    { id: "build:bundle", command: "node", args: ["scripts/build-bundle.mjs"] },
  ];
  const phase2 = [
    { id: "bundle:smoke", command: "node", args: ["dist/bundle/ama.cjs", "--version"] },
  ];
  const phase3 = [
    withE2e
      ? {
          id: "test+e2e",
          command: "pnpm",
          args: ["exec", "vitest", "run"],
          env: { AMA_E2E: "1" },
          stream: true,
        }
      : {
          id: "test",
          command: "pnpm",
          args: ["exec", "vitest", "run"],
          stream: true,
        },
  ];
  return { phase1, phase2, phase3 };
}

/**
 * 清洗传递给子进程的环境：非交互调用方若设了 `TERM=dumb` 会污染启动序列单测的缺省终端环境。
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildChildEnv(baseEnv = process.env, extra = {}) {
  const env = { ...baseEnv, FORCE_COLOR: "0", ...extra };
  if (env.TERM === "dumb" && extra.TERM === undefined) delete env.TERM;
  return env;
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function defaultRunStep(step, writeLine) {
  const started = performance.now();
  return new Promise((resolveStep) => {
    const chunks = [];
    const child = spawn(step.command, step.args, {
      cwd: ROOT,
      shell: isWindows && step.command === "pnpm",
      env: buildChildEnv(process.env, step.env),
    });
    child.stdout.on("data", (chunk) => {
      if (step.stream) process.stdout.write(chunk);
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (step.stream) process.stderr.write(chunk);
      else chunks.push(chunk);
    });
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      const durationMs = performance.now() - started;
      const ok = code === 0;
      const output = step.stream ? "" : Buffer.concat(chunks).toString("utf8");
      writeLine(`  ${ok ? "ok  " : "FAIL"} ${step.id.padEnd(18)} ${formatSeconds(durationMs)}`);
      resolveStep({
        id: step.id,
        ok,
        code: code ?? 1,
        durationMs,
        output,
        streamed: Boolean(step.stream),
      });
    };
    child.on("error", (error) => {
      const text = `${error.message}\n`;
      if (step.stream) process.stderr.write(text);
      else chunks.push(Buffer.from(text));
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

/**
 * 按三阶段执行 CI 计划；任一阶段有失败立即停止后续阶段，并打印完整失败日志。
 */
export async function runCiPlan(plan, options = {}) {
  const started = performance.now();
  const writeLine = options.writeLine ?? ((line) => console.log(line));
  const writeError = options.writeError ?? ((line) => console.error(line));
  const runStep = options.runStep ?? ((step) => defaultRunStep(step, writeLine));
  const allResults = [];

  for (const [index, steps] of [plan.phase1, plan.phase2, plan.phase3].entries()) {
    if (steps.length === 0) continue;
    writeLine(`ci: 阶段 ${index + 1}/${3}（${steps.map((s) => s.id).join("、")}）`);
    const results =
      steps.length === 1
        ? [await runStep(steps[0])]
        : await Promise.all(steps.map((s) => runStep(s)));
    allResults.push(...results);
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      for (const failure of failed) {
        if (!failure.streamed && failure.output.trim().length > 0) {
          writeError(
            `\n── ${failure.id} 失败（退出码 ${failure.code}）──\n${failure.output.trimEnd()}\n`,
          );
        } else if (!failure.streamed) {
          writeError(`\n── ${failure.id} 失败（退出码 ${failure.code}，无输出）──`);
        }
      }
      writeError(
        `ci: 失败（${failed.map((f) => f.id).join("、")}，共 ${formatSeconds(performance.now() - started)}）`,
      );
      return { ok: false, results: allResults };
    }
  }

  writeLine(`ci: 全部通过（共 ${formatSeconds(performance.now() - started)}）`);
  return { ok: true, results: allResults };
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    console.error(`ci: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  const { ok } = await runCiPlan(buildCiPlan(parsed));
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
