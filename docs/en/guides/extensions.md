# Local extensions

English · [简体中文](../../guides/extensions.md)

> Translated from the Chinese [docs/guides/extensions.md](../../guides/extensions.md) as of commit `b61be61`. When the two differ, the Chinese
> version is authoritative.

User-installed host adapters, as many as you like: they observe events in-process, register tools and slash commands, and show notifications and status, without taking the host slot (`--host` / profile `host`, e.g. the Armadra canvas). Command hooks ([hooks.md](../../guides/hooks.md), Chinese) only run external commands at fixed points; extensions add the in-process layer.

An extension has **the same module shape as a host adapter**: `HostModule` (`hostApi` + `create(api)`) and receives the same `HostApi`; see [host-api.md](../reference/host-api.md) for the types and members. This page covers what is specific to extensions: loading, coexistence rules, slash commands, trust and `ama doctor`.

## Writing one

```js
// ~/.config/ama/extensions/standup.mjs
export const hostApi = 1;

export function create(api) {
  api.commands.register({
    name: "standup",
    description: "Summarize today's work",
    args: "[day]",
    run(args, ctx) {
      return {
        kind: "prompt",
        text: `Summarize what we did in ${ctx.session.cwd()} ${args || "today"}.`,
      };
    },
  });
  api.events.on("agent_settled", () => api.ui.setStatus("standup", "ready"));
  return { id: "standup" };
}
```

A module is `.mjs` (ESM) or `.cjs`; exporting `default` or named `hostApi` + `create` both work. The adapter returned by `create()` must have an `id` and may have `dispose()` (called on exit). Returning `undefined` means "not enabled".

## Location and loading

- **User-level directory**: `<configDir>/extensions/*.{mjs,cjs}` (default `~/.config/ama/extensions/`, changeable with `AMA_CONFIG_DIR`), sorted by file name.
- **Profile**: `extensions: ["/abs/a.mjs", …]` (absolute paths), after the user-level directory; a path is loaded once.
- **No project level**: `.ama/extensions/` in a repository is not loaded. An extension runs with the process's permissions and can register tools, which is arbitrary code execution, so it does not ship with repositories.
- **Order**: the host adapter activates first; extensions come after it and before the session is assembled (startup step 13).

## Coexistence rules

Each module gets its own `HostApi` instance (its own tool list and status keys) and they share one tool registry, event bus, approval broker slot, resource registry and warming handlers.

| Surface                         | With several modules                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.register`                | First wins; a later duplicate throws `tool_exists` (an extension may catch it; if it does not, `create()` fails and the whole extension is skipped) |
| `tools.disable`                 | Cumulative                                                                                                                                          |
| `instructions.add`              | Appended to the system prompt's `host` section in load order (host adapter first)                                                                   |
| `events.on`                     | All receive, called in registration order                                                                                                           |
| `approvals.setBroker`           | Only the first setter counts (usually the host adapter); other calls are ignored with a warning. The same module may set it again                   |
| `ui.notify` / `ui.setStatus`    | All usable; the status bar merges every module's keys, a later module overrides an earlier one on the same key, so prefix your keys                 |
| `cache.onWarmingDecision`       | The last registered, not yet unregistered handler across modules wins                                                                               |
| `commands.register`             | See below; command names are global, first registration wins                                                                                        |
| `create()` fails / times out    | A host adapter still exits 6; **an extension only produces a warning and is skipped**, startup continues                                            |
| Load failure / version mismatch | Host adapter still exits 6 / 78; an extension is skipped with a warning                                                                             |
| Exit                            | `dispose` in reverse load order (extensions first, host adapter last); a failure only warns                                                         |

With no extensions the system prompt and tool table are byte-identical to before. The `host` field in hook context stays the host adapter's id.

An extension whose `create()` throws is skipped, but tools, event handlers and commands it registered before throwing are not rolled back, so do anything that can fail before registering.

## Slash commands

`api.commands.register({ name, description, args?, run(args, ctx) })` (host-api 1.4, optional member: check `api.commands !== undefined`), available to host adapters and extensions, returns an unregister function.

- **Name**: `^[a-z][a-z0-9-]{0,63}$`, no slash. Registering a built-in command, an alias (`quit`, `q`, `?`), an interactive-UI command (`tree`, `permissions`) or an already registered name throws.
- **Dispatch**: after built-in commands, before prompt templates. A prompt template with the same name is shadowed. `/skill:<name>` is unaffected.
- **`args`**: everything after the command name, trimmed. `description` and `args` (a placeholder such as `"[day]"`) appear in `/help` and completion. No argument completion.
- **`ctx`**: deliberately small, `{ mode, session: { id(), cwd() } }`. For more (send messages, read state) use the `api` you got at registration.
- **Result**: `{ kind: "handled", message? }` (`message` is shown to the user and does not enter the conversation) or `{ kind: "prompt", text }` (send this text as the user prompt); `undefined` means `{ kind: "handled" }`; any other shape is an error, and an error thrown by `run` is shown as an error without affecting the session.
- **Modes**: interactive, line and RPC. In RPC, a `prompt` whose `message` looks like `/name args` and matches an extension command is dispatched inside ama: `handled` emits `message` as a `notification` event and returns `disposition: "handled"` without starting a turn; `prompt` sends its `text` instead. One-shot `-p` runs and ACP do not dispatch slash commands.
- **Listing**: `/help`, interactive completion, RPC `get_commands` (`source: "extension"`).

## Trust

Extensions run with the process's permissions, so they must be trusted before loading. The decision is recorded by the **sha256 of the file content** in the `extensions` section of the user-level `trust.json`:

```json
{
  "version": 1,
  "entries": [],
  "extensions": [
    { "path": "/abs/standup.mjs", "sha256": "…", "trusted": true, "at": "2026-11-15T12:00:00.000Z" }
  ]
}
```

Decision order:

1. `--no-trust`: no extension loads. `--trust` and the profile's `trustProject` **do not affect** extensions (they only cover project-level resources).
2. A record with the same path and the same hash: its decision applies (trusted loads, declined is skipped).
3. No record, or the content changed (hash mismatch):
   - interactive / line mode: at startup, **once**, all pending files are listed with path and sha256 and you are asked (this time only / trust and remember / don't trust); remembered answers go into `trust.json`, and a further content change asks again.
   - other modes (`-p`, RPC, ACP): not loaded, with a warning on stderr. To enable, approve once in an interactive session.

The hash is computed before loading; a file swapped between hashing and loading is out of scope (the local user directory is already one trust domain).

## `ama doctor`

`ama doctor` has a "Local extensions" section: each file's path, the first 12 hex digits of its sha256 and its state: **enabled** (a matching trusted record) or **skipped** with the reason (not trusted, content changed since it was trusted, declined, unreadable, `--no-trust`). Doctor only reads files and trust records and **never runs extension code**, so reasons that only loading can reveal (load failure, version mismatch, `create()` failure, no adapter returned) are not shown there; they appear as warnings in startup output (stderr for `-p` and RPC, the message area in interactive mode).

## Typical uses

| Use             | How                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| Next-step hints | After `events.on("agent_settled")`, derive 2-3 suggestions from the last reply and show them with `ui.notify`    |
| Desktop alerts  | On `agent_settled` and `tool_approval_requested`, write an OSC 777 notification sequence to the terminal         |
| Git checkpoints | On `turn_start`, record a checkpoint with `git stash create` (no working-tree change) and roll back with `/undo` |
| Custom commands | `commands.register({ name: "standup", … })` summarizes today's sessions                                          |
| Warming policy  | `cache.onWarmingDecision` vetoes idle warming by time of day or budget                                           |

## Out of scope

- **No rendering layer**: extensions cannot replace or insert UI components or take over keys. They can express themselves only through message-area notifications, status-bar key/values and slash command output.
- No capability declarations (the trust prompt does not show capabilities), no command argument completion, no dependency order between extensions (only file-name order).
