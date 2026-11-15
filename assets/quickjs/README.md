# quickjs.wasm

QuickJS-ng 0.18.0 compiled to WebAssembly (WASI `wasm32-wasip1`, reactor module, no extensions).
It runs codemode scripts when `codemode.engine` resolves to `quickjs` (docs/guides/codemode.md).

- Source: the `quickjs.wasm` file of the npm package `quickjs-wasi` 3.7.0 (MIT), unmodified. Upstream engine: https://github.com/quickjs-ng/quickjs
- Size: 638148 bytes
- SHA-256: `c0bd8f296e18cf074969f6401b9ecb72609a1323818ec2b9bf7a8f8d740d1363`
- Imports: `env.host_call`, `env.host_interrupt`, `env.host_promise_rejection`, `env.host_module_normalize`, `env.host_module_load`, `env.host_get_timezone_offset` and `wasi_snapshot_preview1.{clock_time_get, fd_close, fd_fdstat_get, fd_seek, fd_write, random_get}`.
- Exports used: `_initialize`, `qjs_init`, `qjs_eval`, `qjs_call`, `qjs_new_host_function` and the other `qjs_*` value helpers (see `src/codemode/quickjs/`).
- License: see `LICENSE` here and `THIRD_PARTY_NOTICES.md` at the repository root.

The file is not a dependency of the package: it is a vendored asset that ships in the npm package (`assets/quickjs/`) and is inlined into `dist/bundle/ama.cjs`.
To replace it, drop in the new binary, update the size and hash above, and run `pnpm test` (the conformance tests in `src/codemode/quickjs/` check the ABI).
