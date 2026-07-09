# Pi Threads Design

## Overview

`pi-threads` is a standalone daemon and CLI for supervising a pool of
single-session `pi --mode rpc` workers. Pi remains the execution engine and Pi
session JSONL files remain the durable transcript source of truth. The daemon
adds a thread-aware control surface for listing sessions, creating and sending
turns, steering or aborting active work, reading messages, exporting
transcripts, and multiplexing multiple Pi workers through local transports.

This project is not a Pi modification. It is an external TypeScript/Bun tool
that spawns `pi --mode rpc` subprocesses, adapts their protocol, and exposes a
daemon API plus a CLI named `pi-threads`.

The daemon is the thread owner while it controls a session. Native Pi must not
start, resume, or otherwise use that same session concurrently: Pi does not
share a lock with `pi-threads`, and external-writer detection is only a
best-effort safety check rather than a coordination protocol.

The design goal is parity in shape and operational discipline with
`codex-threads` and `t3code-threads`, adapted to Pi's actual worker/session
model. CLI and transport adapters stay thin. Core service logic owns scheduling,
worker lifecycle, session catalog lookup, event correlation, leases, and
Pi-specific behavior.

## Product Goals

- Provide a real installed-command experience through `pi-threads`, not a
  development-only `bun run src/index.ts` interface.
- Use regular Pi sessions as the durable catalog so ordinary Pi sessions are
  discoverable without daemon registration.
- Support multiple active Pi sessions by supervising multiple one-session Pi RPC
  workers.
- Preserve cwd-aware behavior for new sessions because Pi creates sessions in
  the worker process cwd.
- Enforce daemon-local single-writer leases for sessions owned by this daemon.
- Offer Unix socket, stdio, and opt-in WebSocket transports over one core API.
- Provide a CLI with table/key-value human output, JSON output, NDJSON stream
  output, and shell completions.
- Keep live smoke opt-in, but make real live smoke exercise real Pi/model turns
  rather than duplicating fake-worker coverage.
- Ship as Bun-built standalone binaries for Linux x86_64/arm64 and macOS
  x86_64/arm64, with verified release archives.

## Non-Goals

- Do not implement `pi-threads` inside the Pi repo.
- Do not modify Pi to satisfy this design.
- Do not add daemon-owned transcript copies, metadata databases, search
  indexes, archive/tag stores, audit logs, or durable event replay.
- Do not expose worker `switch_session` as a public client operation.
- Do not implement daemon-only archive/unarchive state.
- Do not support raw TCP JSONL as a production transport.
- Do not use cookie or browser ambient auth.
- Do not treat the daemon as a security sandbox. Remote access is
  shell-equivalent capability because Pi can run commands and mutate files.

## Runtime And Packaging

Implementation requirements:

- TypeScript with strict typechecking.
- Bun for install, test, smoke, build, and standalone executable generation.
- Node-compatible core code where practical; Bun-specific behavior should stay
  in build/runtime edges.
- `commander` for CLI command parsing.
- Biome for lint/format checks.
- `vitest` for tests.
- `@earendil-works/pi-coding-agent` pinned as the Pi protocol/runtime
  dependency.

The package exposes:

```json
{
  "bin": {
    "pi-threads": "./src/index.ts"
  }
}
```

Recommended scripts:

```json
{
  "start": "bun run src/index.ts",
  "typecheck": "tsc --noEmit",
  "lint": "biome lint --error-on-warnings .",
  "test": "vitest run",
  "check": "bun run typecheck && bun run lint && bun run test",
  "build": "node scripts/build-bun.mjs --bundle --outfile dist/pi-threads.bundle.js",
  "build:exe": "node scripts/build-bun.mjs --outfile bin/pi-threads",
  "build:exe:linux-x86_64": "node scripts/build-bun.mjs --target bun-linux-x64 --outfile bin/release/pi-threads-linux-x86_64",
  "build:exe:linux-arm64": "node scripts/build-bun.mjs --target bun-linux-arm64 --outfile bin/release/pi-threads-linux-arm64",
  "build:exe:macos-arm64": "node scripts/build-bun.mjs --target bun-darwin-arm64 --outfile bin/release/pi-threads-macos-arm64",
  "build:exe:macos-x86_64": "node scripts/build-bun.mjs --target bun-darwin-x64 --outfile bin/release/pi-threads-macos-x86_64",
  "smoke:mock": "bun run smoke/mock-smoke.ts",
  "smoke:live": "bash smoke/live-smoke.sh",
  "verify": "bun run check && bun run smoke:mock && bun run build && bun run build:exe && PI_THREADS_SMOKE_BIN=./bin/pi-threads bun run smoke:mock",
  "package:release": "node scripts/package-release.mjs",
  "release": "node scripts/release.mjs"
}
```

Release archives use these names:

```text
pi-threads-VERSION-linux-x86_64.tar.gz
pi-threads-VERSION-linux-arm64.tar.gz
pi-threads-VERSION-macos-arm64.tar.gz
pi-threads-VERSION-macos-x86_64.tar.gz
```

Each archive contains a top-level `pi-threads-VERSION-PLATFORM` directory with:

- `pi-threads` executable
- `README.md`
- `LICENSE`
- `CHANGELOG.md`
- `config.example.json`
- `smoke/README.md`
- `docs/`

The release script verifies a clean synced `main`, optionally bumps the
package and runtime versions, runs `bun run verify`, commits and tags
`Release vX.Y.Z`, builds and validates every archive from that tag, generates
checksums, and creates the GitHub release before preparing the next
`[Unreleased]` section.

## Repository Layout

```text
src/index.ts                   CLI entrypoint
src/cli/commands.ts            command tree and option parsing
src/cli/runtime.ts             CLI orchestration over daemon client
src/cli/render.ts              human/JSON/stream rendering
src/cli/completion.ts          bash/zsh/fish completion support
src/client/daemon-client.ts    Unix/WebSocket daemon client
src/config.ts                  config defaults, merge, validation, endpoint resolution
src/protocol/                  daemon events, JSON-RPC, response types
src/service/                   core service and event bus
src/session/                   Pi session catalog and external-writer baselines
src/transport/                 Unix socket, stdio, WebSocket, JSON-RPC router
src/security/                  bearer auth, Origin validation, TLS listener checks
src/worker/                    Pi RPC worker adapter and worker pool
test/                          unit and integration-style tests
smoke/                         mock and live smoke harnesses
docs/                          audits and parity notes
scripts/                       release automation
```

## Configuration

Default config path:

```text
~/.config/pi-threads/config.json
```

Config path precedence:

1. `--config PATH`
2. default config path
3. built-in defaults when no config exists

Client target precedence:

1. `--connect ENDPOINT`
2. `--server ALIAS`
3. configured `local` alias
4. daemon Unix socket from config
5. built-in `unix:///tmp/pi-threads.sock`

Config shape:

```json
{
  "defaults": {
    "model": "provider/modelId",
    "thinking": "medium"
  },
  "daemon": {
    "unixSocket": "/tmp/pi-threads.sock",
    "worker": {
      "minWorkers": 0,
      "maxWorkers": 4,
      "idleTtlMs": 300000
    },
    "tcp": {
      "enabled": false,
      "bind": "127.0.0.1",
      "port": 8765,
      "authToken": "literal-token",
      "authTokenEnv": "PI_THREADS_AUTH_TOKEN",
      "allowedOrigins": [],
      "tls": {
        "ca": "/path/ca.pem",
        "cert": "/path/cert.pem",
        "key": "/path/key.pem"
      }
    }
  },
  "servers": {
    "local": {
      "endpoint": "unix:///tmp/pi-threads.sock",
      "authToken": "literal-token",
      "authTokenEnv": "PI_THREADS_AUTH_TOKEN",
      "tlsCa": "/path/ca.pem"
    }
  }
}
```

Config rules:

- `daemon.worker.maxWorkers` must be at least `1`.
- `daemon.worker.minWorkers` defaults to `0`, must be non-negative, and cannot
  exceed `maxWorkers`.
- `daemon.worker.idleTtlMs` defaults to five minutes and must be non-negative.
- `defaults.thinking` must be one of `off`, `minimal`, `low`, `medium`,
  `high`, or `xhigh`.
- `defaults.model` is optional. When set, it applies to new sessions only.
- `servers.<alias>` uses a single `endpoint` string: `unix://`, `ws://`, or
  `wss://`.
- Server aliases inherit `authToken`, `authTokenEnv`, and `tlsCa` unless
  explicit CLI globals override them.
- `daemon.tcp.tls.cert` and `daemon.tcp.tls.key` enable TLS for the WebSocket
  listener.
- `daemon.tcp.tls.ca` is reserved/inert for server-side mTLS today; it must not
  be documented as client-certificate authorization.

New-session default resolution:

1. `new --model` and `new --thinking`
2. `defaults.model` and `defaults.thinking`
3. Pi's configured/default provider, model, and thinking settings

Follow-up `send` commands keep the thread's current Pi settings unless
`--model` or `--thinking` is passed explicitly.

## Architecture

### Core Service

The core service owns:

- Pi session catalog lookup
- worker scheduling and leases
- worker pool lifecycle
- active daemon turn state
- event fanout
- external-writer checks
- Pi RPC worker adaptation
- command semantics for daemon methods

The core service does not:

- parse CLI flags
- render human output
- frame JSONL
- inspect WebSocket headers
- know which transport a caller used
- write client output paths

CLI and transport adapters authenticate, parse, call the service, and render or
frame responses. They do not duplicate scheduling or Pi command logic.

### Session Catalog

Pi session JSONL files are the durable source of truth. `pi-threads` discovers
sessions through Pi `SessionManager` APIs and caches `threadId` to path mappings
in memory.

For unloaded sessions:

- `thread/list`, `thread/search`, `thread/read`, and `thread/messages` read from
  Pi session files.
- `thread/status` can report file-derived idle state.

For loaded or worker-required operations:

- live state comes from the assigned `pi --mode rpc` worker.
- methods such as settings, name, stats, usage, commands, export, compact,
  bash, fork, and clone acquire a worker if the session is not already loaded.

The public `threadId` is the Pi session id. A direct session path may be accepted
as a debug/load handle where the service explicitly resolves thread ids or paths,
but stable CLI/API usage should use the session id.

### Worker Pool

Workers are external `pi --mode rpc` subprocesses. Each worker has one current Pi
session at a time.

Worker requirements:

- Probe `pi --version` before spawning and reject unsupported versions.
- Spawn with `["--mode", "rpc"]`.
- Track `workerId`, pid, version, cwd, state, current `threadId`, active
  `turnId`, and last-used timestamp.
- Validate outbound Pi RPC commands before writing to worker stdin.
- Assign daemon RPC ids; client-supplied worker command ids are rejected.
- Serialize normal commands per worker.
- Allow `abort` and `abort_bash` to bypass the normal command queue so
  cancellation is not blocked behind long work.
- Parse worker stdout defensively. Non-JSON or non-object stdout lines are
  ignored rather than crashing the daemon.
- Reject pending commands and emit a crash event when a worker exits
  unexpectedly.
- On stop, close stdin, send SIGTERM, then SIGKILL after a bounded timeout.

Worker pool requirements:

- `minWorkers` prewarms and maintains that many total workers rooted at the
  daemon process cwd.
- `maxWorkers` is a global capacity cap.
- `idleTtlMs` reaps non-running workers after the configured idle time, trimming
  down to `minWorkers`.
- New sessions are cwd-aware. `thread/start --cwd X` uses an idle worker already
  rooted at `X` and not assigned to a thread, or spawns a new worker in `X`.
- Existing sessions can use an idle worker rooted at the session cwd or an idle
  unassigned worker.
- A selected worker is marked assigned synchronously before any awaited setup
  work. This makes acquisition atomic from the scheduler's point of view.
- During `switch_session`, the worker is temporarily associated with the target
  thread so concurrent lookups see the reservation. On `switch_session` failure
  or cancellation, the association rolls back.
- `switch_session` is internal only and is allowed only for idle/non-running
  workers.

### Active Turn Leases

A daemon turn is one Pi agent-run boundary: Pi `agent_start` through the matching
final Pi `agent_end`.

Requirements:

- Work-starting methods return a daemon-local `turnId`.
- `turnId` values are in-memory and not durable across daemon restarts.
- A thread may have at most one active daemon turn.
- Existing-thread `send` reserves a turn before asynchronous worker assignment
  and settings work, preventing concurrent sends from racing before
  `activeTurns` is populated.
- `steer`, `follow-up`, and `abort` require an active turn and return or affect
  that active turn.
- Promptless `new` completes asynchronously after session setup and releases the
  worker.
- Prompted `new` and `send` return after acceptance unless the CLI waits or
  streams.
- Pi prompt RPC acknowledgment is not terminal completion. Terminal completion
  comes from the final `agent_end`, abort response, worker crash, or explicit
  failure inference.
- Pi `agent_end` with `willRetry: true` is not terminal; the active daemon turn
  remains running until the final `agent_end`, abort, or failure.
- Final `agent_end` with assistant stop reason `error` or `aborted` emits
  `turn.failed` rather than `turn.completed`.
- Terminal daemon events release the worker and advance the session baseline.

### External Writer Detection

External-writer detection is best-effort and process-local.

For sessions the daemon has written during the current process lifetime, it
records file size, mtime, and last-entry identity. Before later write-producing
commands it compares the current file state to the baseline and refuses with
`externalWriterDetected` if the file changed outside daemon-owned execution.

Freshly discovered sessions do not have this protection until the daemon records
a baseline. Direct Pi use still has a race window because Pi does not share a
lock with `pi-threads`.

## Daemon Protocol

JSON-RPC 2.0 over LF-delimited JSONL is used for Unix socket and stdio
transports. WebSocket uses the same JSON-RPC message shapes.

Request:

```json
{ "jsonrpc": "2.0", "id": "1", "method": "thread/send", "params": {} }
```

Success:

```json
{ "jsonrpc": "2.0", "id": "1", "result": {} }
```

Error:

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "error": {
    "code": "busy",
    "message": "Thread already has an active daemon turn",
    "data": {}
  }
}
```

Event notification:

```json
{ "jsonrpc": "2.0", "method": "thread/event", "params": {} }
```

Error codes:

- `invalidParams`
- `unauthorized`
- `forbidden`
- `notFound`
- `busy`
- `capacity`
- `externalWriterDetected`
- `workerCrashed`
- `piRpcError`
- `timeout`
- `internal`

### Methods

Service methods:

- `server/status`
- `server/shutdown`
- `worker/list`
- `worker/read`
- `thread/list`
- `thread/search`
- `thread/read`
- `thread/messages`
- `thread/start`
- `thread/send`
- `thread/steer`
- `thread/follow_up`
- `thread/abort`
- `thread/status`
- `thread/fork`
- `thread/clone`
- `thread/name/set`
- `thread/settings/read`
- `thread/settings/update`
- `thread/compact`
- `thread/export/html`
- `thread/bash/run`
- `thread/bash/abort`
- `thread/commands/list`
- `thread/context/stats`
- `thread/extension-ui/respond`
- `models/list`
- `usage/read`

Subscription methods are adapter-owned. The JSON-RPC router intercepts:

- `subscribe/thread`
- `subscribe/all`
- `subscribe/workers`
- `unsubscribe/thread`

The service exposes subscribe/unsubscribe operations to adapters but these
methods are not normal dispatch cases.

### Events

Daemon event types:

- `turn.accepted`
- `turn.started`
- `run.step.started`
- `run.step.completed`
- `message.delta`
- `message.completed`
- `tool.started`
- `tool.completed`
- `retry.scheduled`
- `retry.completed`
- `queue.updated`
- `compaction.started`
- `compaction.completed`
- `extension_ui.requested`
- `extension_ui.completed`
- `extension.error`
- `turn.completed`
- `turn.aborted`
- `turn.failed`
- `worker.started`
- `worker.idle`
- `worker.crashed`
- `thread.updated`

Pi event mapping:

| Pi event | Daemon event |
| --- | --- |
| `agent_start` | `turn.started` |
| `turn_start` | `run.step.started` |
| `turn_end` | `run.step.completed` |
| `message_start` / `message_update` | `message.delta` |
| `message_end` | `message.completed` |
| `tool_execution_start` | `tool.started` |
| `tool_execution_update` / `tool_execution_end` | `tool.completed` |
| `auto_retry_start` | `retry.scheduled` |
| `auto_retry_end` | `retry.completed` |
| `compaction_start` | `compaction.started` |
| `compaction_end` | `compaction.completed` |
| `extension_ui_request` | `extension_ui.requested` |
| `extension_error` | `extension.error` |
| final successful `agent_end` | `turn.completed` |
| final failed `agent_end` | `turn.failed` |
| `agent_end` with `willRetry: true` | non-terminal `thread.updated` |

Event payloads may include raw Pi event data under `piEvent` or as payload
fields. Transports must not rename daemon event types.

## Transports And Security

### Unix Socket

Unix socket JSON-RPC JSONL is the default local transport.

Requirements:

- Listen on `daemon.unixSocket`.
- Remove stale socket files on startup and close.
- Use strict LF-delimited JSONL.
- No bearer token is required for local Unix socket access.

### stdio

`pi-threads daemon start --stdio` exposes the same JSON-RPC JSONL protocol over
stdin/stdout for parent-owned embedding.

Requirements:

- Keep daemon logs off stdout while stdio JSON-RPC is active.
- Parent process owns lifecycle.
- Cleanly shut down workers on EOF or process termination.

### WebSocket

WebSocket JSON-RPC is opt-in through `daemon.tcp.enabled`.

Requirements:

- Bind to `127.0.0.1` by default.
- Non-loopback binds require both TLS certificate/key and a bearer token.
- Bearer token may come from inline config or an environment variable.
- WebSocket upgrade uses `Authorization: Bearer TOKEN`.
- Token comparison uses timing-safe equality.
- `allowedOrigins` validates browser Origin values. Requests with no Origin are
  permitted because Origin is a browser defense, not general client auth.
- No cookie or ambient browser auth.
- `wss://` client connections may use `tlsCa`.
- Server-side `tls.ca` does not implement mTLS today and must be treated as
  reserved/inert.

## CLI

The installed command is `pi-threads`.

Command shape:

```bash
pi-threads daemon start
pi-threads daemon start --stdio
pi-threads daemon status
pi-threads daemon stop
pi-threads servers
pi-threads servers ping
pi-threads list [--cwd PATH] [--limit N] [--cursor CURSOR] [--since VALUE] [--sort updated|created] [--asc|--desc]
pi-threads search QUERY [--cwd PATH] [--limit N] [--cursor CURSOR] [--since VALUE] [--sort updated|created] [--asc|--desc]
pi-threads show THREAD_ID [--last N] [--asc|--desc] [--items summary|full|none]
pi-threads messages THREAD_ID [--last N] [--since VALUE] [--role user|assistant|tool|bash|custom]
pi-threads new [--cwd PATH] [--name NAME] [--model MODEL] [--thinking LEVEL] [PROMPT]
pi-threads send THREAD_ID [--model MODEL] [--thinking LEVEL] PROMPT
pi-threads steer THREAD_ID PROMPT
pi-threads follow-up THREAD_ID PROMPT
pi-threads abort THREAD_ID
pi-threads status [THREAD_ID]
pi-threads fork THREAD_ID --entry-id ENTRY_ID [--name NAME]
pi-threads clone THREAD_ID [--name NAME]
pi-threads name THREAD_ID NAME
pi-threads settings show THREAD_ID
pi-threads settings set THREAD_ID [--model MODEL] [--thinking LEVEL] [--steering-mode all|one-at-a-time] [--follow-up-mode all|one-at-a-time] [--auto-compaction on|off] [--auto-retry on|off]
pi-threads models [--provider PROVIDER]
pi-threads usage [THREAD_ID]
pi-threads commands THREAD_ID
pi-threads stats THREAD_ID
pi-threads compact THREAD_ID [PROMPT]
pi-threads bash THREAD_ID COMMAND
pi-threads export-html THREAD_ID [OUTPUT]
pi-threads completion [bash|zsh|fish]
pi-threads completion script bash|zsh|fish
```

Global options:

- `--config PATH`
- `--connect ENDPOINT`
- `--server ALIAS`
- `--json`
- `--stream`
- `--no-wait`
- `--auth-token TOKEN`
- `--auth-token-env ENV`
- `--tls-ca PATH`

Global options should be documented before the subcommand, for example:

```bash
pi-threads --server local list
pi-threads --config ./config.json daemon start
```

Output requirements:

- Human output is default and uses tables/key-value formatting with headers.
- Raw daemon event names must not leak in default blocking command output.
- `--json` emits one pretty-printed JSON object.
- `--json --stream` emits NDJSON events for prompted `new` and `send`.
- `--stream` emits filtered human progress for the accepted turn.
- `--no-wait` returns after acceptance.
- Accepted work returns `threadId`, `turnId`, `workerId`, and `status`.
- Blocking prompted `new` and `send` return terminal status plus assistant
  response summaries when available.

Role filter mapping:

- CLI `--role user` maps to Pi `user`.
- CLI `--role assistant` maps to Pi `assistant`.
- CLI `--role tool` maps to Pi `toolResult`.
- CLI `--role bash` maps to Pi `bashExecution`.
- CLI `--role custom` maps to Pi `custom`.

`--since` accepts epoch seconds, ISO timestamps, and relative durations ending
in `ms`, `s`, `m`, `h`, `d`, or `w`.

Shell completions:

- Support bash, zsh, and fish.
- Provide `completion`, `completion script`, and hidden `__complete`.
- Complete commands, nested subcommands, option names, static choices, and
  local configured `--server` aliases.
- Do not connect to the daemon or Pi for completion; thread IDs, entry IDs, and
  remote model IDs are not completed.

## Pi-Specific Operations

### New And Send

`thread/start` creates a new Pi session in the requested cwd and optionally
starts the first prompt. It applies model/thinking defaults only for new
sessions. Model names in `provider/modelId` form are validated before
`new_session` so an invalid explicit model does not create an empty orphan
session.

`thread/send` resolves the existing session, asserts daemon-owned baseline state
when available, reserves the turn, assigns or switches a worker, applies
explicit settings overrides, then sends the prompt.

### Steering, Follow-up, Abort

`thread/steer`, `thread/follow_up`, and `thread/abort` require an active daemon
turn. Abort clears active state, releases the worker, and emits `turn.aborted`.

### Fork And Clone

`thread/fork` requires `entryId` and is rejected for threads with active daemon
turns. The resulting session becomes a new thread and the worker is assigned to
that new session.

`thread/clone` clones the whole session and is also rejected for active daemon
turns.

Both check Pi response `cancelled: true` and fail instead of assigning the wrong
thread id.

### Settings

Settings read/update uses live Pi worker state and commands:

- model
- thinking level
- steering mode
- follow-up mode
- auto-compaction
- auto-retry

Model resolution accepts `provider/modelId` or a model id/name found in Pi's
available model list. `provider/modelId` must have exactly one slash and
non-empty provider/model parts.

### Messages

Loaded sessions use worker `get_messages`. Unloaded sessions read Pi session
JSONL entries. Filtering applies role, since, and last in service code so loaded
and catalog-backed paths have the same behavior.

### Export HTML

The daemon never writes client-provided output paths. It calls Pi `export_html`
with a daemon-owned temporary path, reads the generated HTML, deletes the temp
directory, and returns content to the client. The CLI writes `[OUTPUT]` locally.

### Extension UI

Pi `extension_ui_request` events are exposed as `extension_ui.requested`.
Direct RPC clients answer with `thread/extension-ui/respond`. The response
payload cannot override the required `type: "extension_ui_response"` or request
`id` envelope fields.

There is no interactive CLI command for extension UI responses; this is a direct
daemon RPC surface for embedders.

## Testing And Smoke

Required source validation:

```bash
bun run check
```

For protocol, transport, CLI, worker, or smoke behavior changes:

```bash
bun run smoke:mock
```

Release-oriented validation:

```bash
bun run verify
```

Test coverage requirements:

- config defaults, validation, and endpoint resolution
- auth and TLS listener checks
- JSON-RPC request/error/subscription behavior
- event bus filtering/replay
- human rendering
- shell completion candidates and scripts
- worker command validation, serialization, malformed stdout tolerance, and stop
  cleanup
- worker pool min/max/idle lifecycle, atomic acquisition, switch rollback,
  crash recovery, and Pi event mapping
- service defaults, role filtering, read/list/search filters, extension UI
  envelope handling, and active-turn behavior
- deterministic end-to-end mock smoke with a generated fake `pi` executable

Mock smoke requirements:

- Does not spend model tokens.
- Starts a disposable daemon over a Unix socket.
- Uses a generated fake `pi` binary.
- Exercises representative CLI commands.
- Emits real Pi event names such as `message_end` and `agent_end` with
  `willRetry: false`.
- Verifies default prompted output does not leak raw daemon event names.

Live smoke requirements:

- Opt-in only; never part of `check` or `verify` by default.
- Uses real `pi --mode rpc` workers.
- Uses disposable working directories and config.
- Runs real model turns by default for real integration coverage.
- Covers daemon startup, models, `new`, `send`, `status`, `messages`, `steer`,
  `abort`, cwd-specific worker assignment, and concurrent multi-worker
  execution.
- Supports `PI_THREADS_MODEL` and `PI_THREADS_THINKING` to pin model settings;
  otherwise it inherits Pi's configured/default provider/model.
- Documents cleanup and token-costing behavior in `smoke/README.md`.

## Documentation Requirements

`README.md` must be the main user-facing guide and include:

- what `pi-threads` is and is not
- release install instructions using the `pi-threads` binary
- quickstart
- daemon startup
- common workflows
- configuration
- command table
- shell completions
- output modes
- architecture summary
- transports and security
- tests and smoke
- development
- release archive packaging
- compatibility matrix
- known limitations

`CHANGELOG.md` tracks user-facing changes. `docs/cli-parity-audit.md` and
`docs/config-option-implementation-audit.md` document intentional parity gaps
and option implementation status.

Design docs should describe the intended end state, not implementation history.
Changelog-style notes belong in `CHANGELOG.md`.

## Compatibility

Current compatibility target:

| pi-threads | Tested Pi | Status |
| --- | --- | --- |
| 0.1.x | 0.75.x through 0.80.x | Initial supported range |

Worker assignment refuses unsupported `pi --version` values.

Pi surfaces used:

- `pi --mode rpc`
- `--version`
- `new_session`
- `switch_session`
- `prompt`
- `steer`
- `follow_up`
- `abort`
- `fork`
- `clone`
- `set_session_name`
- `get_state`
- `get_messages`
- `get_available_models`
- `get_session_stats`
- `get_commands`
- `set_model`
- `set_thinking_level`
- `set_steering_mode`
- `set_follow_up_mode`
- `set_auto_compaction`
- `set_auto_retry`
- `compact`
- `export_html`
- `bash`
- `abort_bash`

Pi event names used:

- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `queue_update`
- `compaction_start`
- `compaction_end`
- `auto_retry_start`
- `auto_retry_end`
- `extension_ui_request`
- `extension_error`

## Known Limitations

- Active Pi work is not recovered after daemon restart.
- Daemon `turnId` values are in-memory only.
- External-writer detection is best-effort and process-lifetime scoped.
- Native Pi must not use a daemon-owned session concurrently because Pi does
  not share a lock with `pi-threads`.
- Usage/account data is best-effort and depends on Pi RPC/session surfaces.
- `daemon.tcp.tls.ca` does not implement mTLS today.
- WebSocket `allowedOrigins` protects browser clients only; non-browser clients
  without Origin still require bearer token auth.
- Authenticated remote clients have shell-equivalent capability.
- Extension UI response is available through RPC but not through an interactive
  CLI command.
- No daemon-owned archive, tags, durable replay, audit log, transcript copy,
  search database, or thread registry.

## Operational Invariants

- Core service logic is separate from CLI rendering and transport adapters.
- Pi worker protocol adaptation stays in worker modules.
- CLI and transports do not duplicate command semantics.
- Workers are cwd-aware for new sessions.
- Same-session writes are protected by daemon-local active turn leases.
- Worker acquisition is atomic from the pool's perspective.
- `switch_session` is internal and never public.
- Prompt RPC acknowledgment is not terminal turn completion.
- `agent_end willRetry:true` is non-terminal.
- Failed Pi runs surface as `turn.failed`, not `turn.completed`.
- Real Pi event names are used in mocks and event mapping.
- Live smoke remains opt-in; mock smoke is the no-cost default coverage.
