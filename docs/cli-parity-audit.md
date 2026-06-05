# CLI Parity Audit

This audit compares `pi-threads` with the command shape expectations in `DESIGN.md`,
`../t3code-threads`, and `../codex-threads`.

## Implemented Parity

- Parser/execution/rendering are separated:
  - `src/cli/commands.ts` declares Commander commands.
  - `src/cli/runtime.ts` owns daemon client orchestration and work waits.
  - `src/cli/render.ts` owns human/JSON rendering.
- Human output uses padded tables and key-value rows, not TSV.
- `servers ping` is a nested subcommand.
- `completion`, `completion script`, and hidden `__complete` support bash, zsh, and fish.
- Completion candidates include commands, options, option choices, and configured `--server` aliases.
- `list` supports `--cwd`, `--limit`, `--cursor`, `--since`, `--sort updated|created`, `--asc`, and `--desc`.
- `search` supports `--cwd`, `--limit`, `--cursor`, `--since`, `--sort updated|created`, `--asc`, and `--desc`.
- `show` supports `--last`, `--asc`, `--desc`, and `--items summary|full|none`.
- `messages` supports `--last`, `--since`, and `--role user|assistant|tool|bash|custom`.
- `new`, `send`, and `settings set` validate Pi thinking levels.
- `settings set` validates queue modes and boolean states.
- `models --provider` filters model rows when Pi reports provider metadata.
- Default `new`/`send` waits filter events to the accepted turn and do not print raw daemon event names.
- Explicit `--stream` prints filtered event progress; `--json --stream` prints NDJSON events.

## Intentional Differences

- `--archived` is rejected for `list` and `search`. `pi-threads` does not maintain a daemon archive/tag store.
- Codex `archive`, `unarchive`, and `goal` commands are not implemented for the same no-metadata-store reason.
- Codex `effort`, `service-tier`, `runtime-mode`, and `interaction-mode` are not Pi RPC concepts. Pi uses `--thinking` and model selection.
- Pi `steer` and `follow-up` are thread-scoped. Codex `steer`/`interrupt` require a turn id.
- `messages --max-turns` is not implemented because Pi sessions are JSONL entries, not Codex turn pages.
- `status --load` is not implemented. Pi thread status reports daemon-owned worker state when loaded and file-derived idle state otherwise.

## Worker And Thread State

- Worker state `assigned` means a Pi RPC worker has a session loaded and is leased to that thread, but no active turn is running.
- Worker state `running` means the daemon has observed active Pi execution for that worker.
- Thread list/search/status report `running` only for daemon-owned active turns or running workers; assigned but inactive workers leave the thread status as `idle`.

## Validation

- Unit coverage includes table rendering, `show` rendering, completion candidates, list/search filtering, message filtering, and worker-state thread overlays.
- Mock smoke covers daemon startup, representative CLI commands, and a prompted `new` assertion that default output does not leak raw daemon events.
