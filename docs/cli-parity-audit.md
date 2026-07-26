# CLI And Config Parity Audit

Date: 2026-06-05

This audit compares `pi-threads` with `DESIGN.md`, `../codex-threads`, and
`../t3code-threads`. "Parity" here means parity for concepts that exist in Pi
RPC/session APIs and are allowed by the repository rule that `pi-threads` must
not create daemon-owned metadata stores.

## Audit Surface

- CLI command names, argument shapes, choices, and flag consumers.
- Config defaults and target/alias resolution.
- Core service behavior behind each CLI command.
- Human rendering and JSON/NDJSON output shapes.
- Shell completion support.
- Smoke coverage and documented validation paths.
- Explicit non-parity where Pi lacks the concept or the repo rules forbid it.

## Command Matrix

| Area | Parity status |
| --- | --- |
| `servers`, `servers ping` | Implemented as a command plus nested `ping`, matching the reference command shape. |
| `daemon start/status/stop` | Implemented for the Pi daemon. `server/status` reports active transport names. |
| `list` | Implements `--cwd`, `--limit`, `--cursor`, `--since`, `--sort updated\|created`, `--asc`, and `--desc`. `--archived` is accepted by the parser but rejected at runtime because Pi has no daemon archive store. |
| `search` | Implements `QUERY`, `--cwd`, `--limit`, `--cursor`, `--since`, `--sort updated\|created`, `--asc`, and `--desc`; filters and sorting run before paging. |
| `show` | Implements `--last`, `--asc`, `--desc`, and `--items summary\|full\|none` over Pi session entries. |
| `messages` | Implements `--last`, `--since`, and `--role user\|assistant\|tool\|bash\|custom` for loaded-worker and catalog-backed sessions. |
| `new` | Implements `--cwd`, `--name`, `--model`, `--thinking`, prompt/no-prompt behavior, wait/no-wait, streaming, and daemon config defaults. |
| `send` | Implements `--model`, `--thinking`, prompt, wait/no-wait, and streaming. Omitted model/thinking inherit the thread's current Pi settings. |
| `steer`, `follow-up`, `abort`, `status` | Implemented in Pi terms. Pi steering/follow-up are thread-scoped; Codex turn-id-scoped steering is not a Pi concept. |
| `fork`, `clone`, `name` | Implemented through Pi session/worker operations. |
| `settings show`, `settings set` | Implemented. `settings set` validates thinking levels, queue modes, and boolean states. |
| `models` | Implemented with optional `--provider` filtering when Pi reports provider metadata. |
| `usage`, `commands`, `stats` | Implemented as best-effort Pi surfaces through session stats, command listing, and context stats. |
| `export-html`, `compact`, `bash` | Implemented through Pi RPC worker commands. |
| `completion`, `completion script`, `__complete` | Implemented for bash, zsh, and fish. Candidates include commands, options, choices, and local `--server` aliases. |

## Config Matrix

| Area | Parity status |
| --- | --- |
| Config path and endpoint selection | `--config`, `--connect`, and `--server` are implemented. `--connect` overrides server aliases. |
| Server aliases | `servers.*.endpoint`, `authToken`, `authTokenEnv`, and `tlsCa` are inherited by `--server ALIAS`; explicit CLI flags override alias auth/CA. |
| Model default | `defaults.model` initializes new Pi sessions when `new` omits `--model`. Values may be `provider/modelId` or a configured Pi model id/name. |
| Reasoning/thinking default | `defaults.thinking` initializes new Pi sessions when `new` omits `--thinking`; allowed values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. |
| Existing-thread sends | Match reference behavior by inheriting the existing thread's settings unless `send --model` or `send --thinking` is explicit. |
| Worker lifecycle | `minWorkers`, `maxWorkers`, and `idleTtlMs` are implemented and validated. |
| Transport security | Unix, stdio daemon mode, and opt-in WebSocket are implemented. Non-loopback WebSocket requires TLS and bearer auth. |

## Rendering And Streaming

- Human output uses padded tables and key-value rows, not TSV.
- Message output uses timestamped role blocks.
- Default `new` and `send` wait quietly and do not print raw daemon event names.
- Explicit `--stream` prints progress filtered to the accepted turn.
- `--json --stream` emits NDJSON records, including the accepted result and events.

## Intentional Differences

- Codex `archive`, `unarchive`, and `goal` commands are not implemented because
  they require daemon-owned metadata stores.
- `--archived` is rejected for `list` and `search` for the same reason.
- Codex `effort`, `service-tier`, `runtime-mode`, and `interaction-mode` are
  not Pi RPC concepts. Pi uses model selection plus `thinking`.
- T3/Codex per-server model defaults map to upstream target selection. In
  `pi-threads`, `servers.*` are daemon endpoint aliases, so model/thinking
  defaults live in daemon-owned `defaults` instead of client-side server aliases.
- `messages --max-turns` is not implemented because Pi sessions are JSONL
  entries, not Codex turn pages.
- `status --load` is not implemented. Pi thread status reports daemon-owned
  worker state when loaded and file-derived idle state otherwise.
- Client certificate/mTLS flags are not implemented. Add them only with a new
  explicit mTLS design.

## Remaining Deferred Smoke/Transport Work

- `PI_THREADS_TRANSPORT=stdio` is documented as reserved; there is no dedicated
  parent-owned stdio smoke harness.
- `PI_THREADS_AUTH_TOKEN_ENV` and `PI_THREADS_TLS_CA` are documented for future
  WebSocket live smoke, but the current live smoke script does not start a
  WebSocket daemon path.
- Optional live smoke flags for bash, fork, and external-writer scenarios are
  design-era deferred paths.

## Validation

- Unit coverage includes config defaults and validation, alias auth/CA
  inheritance, table rendering, `show` rendering, completion candidates,
  list/search filtering, message filtering, worker-state thread overlays, and
  non-loopback WebSocket auth/TLS requirements.
- Mock smoke covers daemon startup, representative CLI commands, and a prompted
  `new` assertion that default output does not leak raw daemon events.
- Live smoke covers real Pi/model turns, send, status, messages, steer, abort,
  and concurrent multi-worker execution.
