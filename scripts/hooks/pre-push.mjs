/**
 * 推送前本地把关（#299）。`.githooks/pre-push` 调用，`pnpm install` 时由
 * `scripts/hooks/install.mjs` 把 `core.hooksPath` 指到 `.githooks`。
 *
 * 只查这次推送带上的改动，判定与 CI（.github/workflows/ci.yml）一致：
 *
 * - 改动按推送的 ref 范围算：已有的远端分支是「远端旧值..本地新值」，新分支是相对
 *   远端缺省分支的合并基点。删除分支、只推 tag 时什么都不做。
 * - 只改文档（CI 的 `changes` 判定）：改动文件的 prettier 与 `check:docs`。
 * - 有代码：并行跑 typecheck、改动文件的 prettier、`check:deps`、`check:i18n`、`check:docs`、
 *   `release:check`、`check:portability`；改了源码或构建相关的文件时构建，做 bundle 冒烟与
 *   bundle 端到端（`AMA_E2E=1 vitest run test/e2e`）；单测 `vitest run --changed <基点>`，
 *   配置、夹具与测试辅助变了全量。workflow 改了且装了 actionlint 就跑 CI 同款的
 *   actionlint；models.dev 相关文件改了跑 CI 同款的 dry-run。
 *
 * 失败就拦下推送（退出码 1）。临时跳过：`git push --no-verify`，或
 * `ARMADRA_SKIP_PREPUSH=1`（全部）/ `ARMADRA_SKIP_PREPUSH=test,e2e`（指定步骤）。
 * 每步完整输出在 node_modules/.cache/pre-push/<步骤>.log。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LOG_DIR = join(ROOT, "node_modules/.cache/pre-push");
const ZERO = /^0+$/;
const isWindows = process.platform === "win32";

/** 命令行一次传多少个文件；再多就改跑全量，免得撞上 Windows 的命令行长度上限。 */
const MAX_FILE_ARGS = 200;

/** CI 的 `changes` 作业：只有这些改动时只跑 docs 作业。 */
export function isDocsOnly(files) {
  return (
    files.length > 0 &&
    files.every(
      (file) =>
        file !== "THIRD_PARTY_NOTICES.md" &&
        !file.startsWith("docs/contracts/") &&
        (file.endsWith(".md") ||
          file.startsWith("docs/") ||
          file.startsWith(".github/ISSUE_TEMPLATE/")),
    )
  );
}

const FORMAT_GLOBAL = [
  /^\.prettierrc/,
  /^\.prettierignore$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
];
/** 这些一变，vitest 的模块图看不全：全量。 */
const TEST_GLOBAL = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^vitest\.config\.ts$/,
  /^tsconfig[^/]*\.json$/,
  /^test\/(helpers|fixtures)\//,
  /^assets\//,
];
/** 这些一变要重新构建 bundle 并冒烟。 */
const BUILD =
  /^(src\/|assets\/|scripts\/build-bundle\.mjs$|package\.json$|pnpm-lock\.yaml$|tsconfig)/;
const TEST_SOURCE = /\.test\.ts$/;
const MODELS_DEV =
  /^(scripts\/update-models-dev\.mjs$|test\/fixtures\/models-dev\/|src\/ai\/providers\/|\.github\/workflows\/models-dev\.yml$)/;
const WORKFLOWS = [".github/workflows/models-dev.yml", ".github/workflows/ci.yml"];

/**
 * 按改动的文件排出要跑的步骤。返回 `{ docsOnly, statics, build, after, actionlint, modelsDev }`；
 * 步骤是 `{ id, command, args, env? }`。
 */
export function planChecks(files, { base, exists = () => true } = {}) {
  const present = files.filter(exists);
  const format =
    files.some((file) => FORMAT_GLOBAL.some((re) => re.test(file))) ||
    present.length > MAX_FILE_ARGS
      ? { id: "format", command: "pnpm", args: ["fmt:check"] }
      : present.length > 0
        ? {
            id: "format",
            command: "pnpm",
            args: ["exec", "prettier", "--check", "--ignore-unknown", ...present],
          }
        : null;
  const docs = { id: "check:docs", command: "pnpm", args: ["check:docs"] };
  if (isDocsOnly(files))
    return {
      docsOnly: true,
      statics: [format, docs].filter(Boolean),
      build: [],
      after: [],
      actionlint: false,
      modelsDev: false,
    };

  const statics = [
    format,
    docs,
    ...["typecheck", "check:deps", "check:i18n", "release:check", "check:portability"].map(
      (id) => ({ id, command: "pnpm", args: [id] }),
    ),
  ].filter(Boolean);
  const build = files.some((file) => BUILD.test(file) && !TEST_SOURCE.test(file))
    ? [
        { id: "build", command: "pnpm", args: ["build"] },
        { id: "bundle", command: "node", args: ["dist/bundle/ama.cjs", "--version"] },
      ]
    : [];
  const everything = base === null || files.some((file) => TEST_GLOBAL.some((re) => re.test(file)));
  const testable = files.some((file) => /^(src|test)\//.test(file));
  const after = [];
  if (everything || testable)
    after.push({
      id: "test",
      command: "pnpm",
      args: [
        "exec",
        "vitest",
        "run",
        ...(everything ? [] : ["--changed", base, "--passWithNoTests"]),
      ],
    });
  if (build.length > 0 || files.some((file) => file.startsWith("test/e2e/")))
    after.push({
      id: "e2e",
      command: "pnpm",
      args: ["exec", "vitest", "run", "test/e2e"],
      env: { AMA_E2E: "1" },
      needsBuild: build.length === 0,
    });
  return {
    docsOnly: false,
    statics,
    build,
    after,
    actionlint: files.some((file) => WORKFLOWS.includes(file)),
    modelsDev: files.some((file) => MODELS_DEV.test(file)),
  };
}

/** pre-push 的标准输入：每行「本地 ref 本地 sha 远端 ref 远端 sha」。 */
export function parsePushLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({
      localRef,
      localSha,
      remoteRef,
      remoteSha,
    }));
}

/** 要查的 ref：删除（本地 sha 全 0）与非分支（tag 等）都不查。 */
export function refsToCheck(updates) {
  return updates.filter(
    (update) => !ZERO.test(update.localSha) && update.remoteRef.startsWith("refs/heads/"),
  );
}

/** 解析 `ARMADRA_SKIP_PREPUSH`：`{ all }` 或要跳过的步骤名集合。 */
export function parseSkip(value) {
  const text = (value ?? "").trim();
  if (text === "") return { all: false, steps: new Set() };
  if (text === "1" || text === "true" || text === "all") return { all: true, steps: new Set() };
  return {
    all: false,
    steps: new Set(
      text
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  };
}

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function defaultBranch(remote) {
  const head = git(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  if (head) return head.replace(/^refs\/remotes\//, "");
  for (const candidate of [`${remote}/main`, "origin/main"])
    if (git(["rev-parse", "--verify", "--quiet", candidate])) return candidate;
  return null;
}

/** 已有的远端分支用远端旧值（强推时取合并基点），新分支用缺省分支的合并基点。 */
function baseOf(update, remote) {
  if (
    !ZERO.test(update.remoteSha) &&
    git(["cat-file", "-e", `${update.remoteSha}^{commit}`]) !== null
  )
    return git(["merge-base", update.remoteSha, update.localSha]);
  const branch = defaultBranch(remote);
  return branch ? git(["merge-base", branch, update.localSha]) : null;
}

function runStep(step) {
  const started = Date.now();
  const log = join(LOG_DIR, `${step.id.replace(/[^\w.-]/g, "_")}.log`);
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(step.command, step.args, {
      cwd: ROOT,
      shell: isWindows,
      env: { ...process.env, FORCE_COLOR: "0", ...step.env },
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      writeFileSync(log, Buffer.concat(chunks));
      console.log(
        `  ${ok ? "ok  " : "FAIL"} ${step.id} ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      resolve({ id: step.id, ok, log });
    };
    child.on("error", (error) => {
      chunks.push(Buffer.from(`${error.message}\n`));
      finish(false);
    });
    child.on("close", (code) => finish(code === 0));
  });
}

async function sequence(steps) {
  const results = [];
  for (const step of steps) {
    const result = await runStep(step);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

function tail(file, lines = 30) {
  return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

/** CI 的 models-dev 检查：离线快照 dry-run，摘要里要有标题，且不改 src/ai/providers。 */
async function modelsDevStep() {
  const scratch = mkdtempSync(join(tmpdir(), "ama-prepush-models-dev-"));
  try {
    const summary = join(scratch, "summary.md");
    const result = await runStep({
      id: "models-dev",
      command: "node",
      args: [
        "-e",
        [
          'const { execFileSync } = require("node:child_process");',
          'const fs = require("node:fs");',
          "const [out, data, summary] = process.argv.slice(1);",
          'const text = execFileSync(process.execPath, ["scripts/update-models-dev.mjs", "--dry-run", "--min-providers", "1", "--out", out, "--data-out", data, "--input", "test/fixtures/models-dev/snapshot-api.json", "--list", "test/fixtures/models-dev/snapshot-providers.json"], { encoding: "utf8" });',
          "fs.writeFileSync(summary, text);",
          'if (!text.includes("models.dev 快照刷新")) { console.error("摘要里没有「models.dev 快照刷新」"); process.exit(1); }',
          'execFileSync("git", ["diff", "--exit-code", "--", "src/ai/providers"], { stdio: "inherit" });',
        ].join("\n"),
        join(scratch, "out"),
        join(scratch, "data.ts"),
        summary,
      ],
    });
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(argv, input) {
  // git 给钩子设的 GIT_DIR、GIT_INDEX_FILE 等会被子进程继承：测试在临时目录里起的 git
  // 会找错仓库（「must be run in a work tree」）。和 CI 一样干净，全部去掉。
  for (const name of Object.keys(process.env))
    if (name.startsWith("GIT_")) delete process.env[name];
  const skip = parseSkip(process.env.ARMADRA_SKIP_PREPUSH);
  if (skip.all) return 0;
  const remote = argv[0] && !argv[0].includes("/") ? argv[0] : "origin";
  const refs = refsToCheck(parsePushLines(input));
  if (refs.length === 0) return 0;

  const head = git(["rev-parse", "HEAD"]);
  const files = new Set();
  let base = null;
  let unknownBase = false;
  for (const ref of refs) {
    const refBase = baseOf(ref, remote);
    if (!refBase) {
      unknownBase = true;
      continue;
    }
    if (ref.localSha === head || base === null) base = refBase;
    const diff = git(["diff", "--name-only", refBase, ref.localSha]);
    for (const file of (diff ?? "").split("\n").filter(Boolean)) files.add(file);
  }
  const changed = [...files].sort();
  if (changed.length === 0 && !unknownBase) return 0;
  if (!existsSync(join(ROOT, "node_modules"))) {
    console.error("pre-push：没装依赖，先 pnpm install（或 git push --no-verify 跳过检查）");
    return 1;
  }
  mkdirSync(LOG_DIR, { recursive: true });

  const plan = planChecks(unknownBase ? ["package.json", ...changed] : changed, {
    base: unknownBase ? null : base,
    exists: (file) => existsSync(join(ROOT, file)),
  });
  console.log(
    `pre-push：${unknownBase ? "拿不到基点，按全量" : `相对 ${base.slice(0, 9)} 改了 ${changed.length} 个文件`}${plan.docsOnly ? "（只有文档）" : ""}`,
  );
  if (refs.some((ref) => ref.localSha !== head))
    console.log("  注意：推送的提交不是当前检出，检查跑在工作区上");
  const dirty = (git(["status", "--porcelain"]) ?? "")
    .split("\n")
    .map((line) => line.slice(3))
    .filter((file) => files.has(file));
  if (dirty.length > 0)
    console.log(`  注意：${dirty.length} 个改动文件还有未提交的修改，检查看的是工作区内容`);

  const keep = (step) => {
    if (!skip.steps.has(step.id)) return true;
    console.log(`  skip ${step.id}`);
    return false;
  };
  const statics = plan.statics.filter(keep).map(runStep);
  if (plan.actionlint && keep({ id: "actionlint" })) {
    if (spawnSync("actionlint", ["-version"], { stdio: "ignore" }).status === 0)
      statics.push(
        runStep({ id: "actionlint", command: "actionlint", args: ["-shellcheck=", ...WORKFLOWS] }),
      );
    else console.log("提示：改了 workflow，本机没有 actionlint；CI 的 Linux / Node 24 会跑");
  }
  if (plan.modelsDev && keep({ id: "models-dev" })) statics.push(modelsDevStep());
  const results = await Promise.all(statics);
  if (results.every((result) => result.ok))
    results.push(...(await sequence(plan.build.filter(keep))));
  if (results.every((result) => result.ok)) {
    const after = plan.after.filter(keep);
    // 只改了 e2e 用例而没重新构建：bundle 不存在就先构建。
    if (after.some((step) => step.needsBuild) && !existsSync(join(ROOT, "dist/bundle/ama.cjs")))
      results.push(...(await sequence([{ id: "build", command: "pnpm", args: ["build"] }])));
    if (results.every((result) => result.ok)) results.push(...(await sequence(after)));
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) return 0;
  for (const result of failed)
    console.log(`\n── ${result.id} 失败（完整输出：${result.log}）──\n${tail(result.log)}`);
  console.log(
    [
      "",
      `推送已拦下：${failed.map((result) => result.id).join("、")} 失败。修好、提交后再推。`,
      "  格式：pnpm fmt；单测：pnpm exec vitest run <文件>；跨平台：PATH 用 path.delimiter 拼。",
      `  确需先推：git push --no-verify，或 ARMADRA_SKIP_PREPUSH=${failed[0].id} git push 只跳过这一步。`,
    ].join("\n"),
  );
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), readFileSync(process.stdin.fd, "utf8"));
}
