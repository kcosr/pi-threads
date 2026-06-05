# pi-threads

`pi-threads` is a TypeScript daemon and CLI that exposes a thread-aware control surface over a pool of single-session `pi --mode rpc` workers. Pi remains the execution engine and Pi session JSONL files remain the durable transcript source of truth.

This tool is not a Pi modification. It supervises external Pi RPC subprocesses, routes work to the right worker, multiplexes events, and exposes Unix socket, stdio, and opt-in secured WebSocket transports over one core service API.

## Install And Develop

```bash
bun install
bun run check
bun run smoke:mock
```

The package pins `@earendil-works/pi-coding-agent@0.75.5` and records `0.75.x` as the tested Pi protocol range. Worker assignment refuses unsupported `pi --version` values.

## Quickstart

Start a local daemon over the default Unix socket:

```bash
bun run src/index.ts daemon start
```

Use another shell for client commands:

```bash
bun run src/index.ts servers ping
bun run src/index.ts list --cwd "$PWD" --since 24h --sort updated --limit 20
bun run src/index.ts search "release process" --since 7d --limit 10
bun run src/index.ts new --cwd "$PWD" --name demo "Summarize this project"
bun run src/index.ts status THREAD_ID
bun run src/index.ts messages THREAD_ID --last 10
bun run src/index.ts send THREAD_ID "Continue"
bun run src/index.ts steer THREAD_ID "Prefer a shorter answer"
bun run src/index.ts follow-up THREAD_ID "Then list next steps"
bun run src/index.ts abort THREAD_ID
bun run src/index.ts fork THREAD_ID --entry-id ENTRY_ID --name forked
bun run src/index.ts clone THREAD_ID --name cloned
bun run src/index.ts name THREAD_ID "new name"
bun run src/index.ts settings show THREAD_ID
bun run src/index.ts settings set THREAD_ID --thinking medium --steering-mode all --follow-up-mode one-at-a-time
bun run src/index.ts models
bun run src/index.ts usage THREAD_ID
bun run src/index.ts commands THREAD_ID
bun run src/index.ts stats THREAD_ID
bun run src/index.ts export-html THREAD_ID out.html
bun run src/index.ts compact THREAD_ID "Keep implementation decisions"
bun run src/index.ts bash THREAD_ID "pwd"
bun run src/index.ts daemon stop
```

Global flags:

- `--config PATH`
- `--connect ENDPOINT`
- `--server ALIAS`
- `--json`
- `--stream`
- `--no-wait`
- `--auth-token TOKEN`
- `--auth-token-env ENV`
- `--tls-ca PATH`

Work-starting commands return `threadId` and daemon-local `turnId`. Default `new` and `send` behavior waits until `turn.completed`, `turn.aborted`, or `turn.failed` without printing raw daemon events; `--stream` prints filtered event progress for the accepted turn, `--json --stream` emits NDJSON events, and `--no-wait` returns after acceptance.

`defaults.model` and `defaults.thinking` initialize new Pi sessions when `new` omits `--model` or `--thinking`. Existing-thread `send` inherits that thread's current Pi settings unless the command passes explicit model or thinking overrides.

Read command filters:

- `list` and `search` support `--limit`, `--cursor`, `--since`, `--cwd`, `--sort updated|created`, `--asc`, and `--desc`.
- `show` supports `--last`, `--asc`, `--desc`, and `--items summary|full|none`.
- `messages` supports `--last`, `--since`, and `--role user|assistant|tool|bash|custom`.
- `--since` accepts epoch seconds, ISO timestamps, or relative windows such as `5m`, `24h`, and `7d`.
- `--archived` is rejected because `pi-threads` does not maintain a daemon-owned archive store.

Shell completions:

```bash
bun run src/index.ts completion
bun run src/index.ts completion script bash
```

See `docs/config-option-implementation-audit.md` for the current implementation status of configurable and documented options. See `docs/cli-parity-audit.md` for command-shape parity with `codex-threads` and `t3code-threads`.

## Config

Default config path:

```text
~/.config/pi-threads/config.json
```

See `config.example.json` for a complete example. The daemon stores only config JSON. It does not maintain a transcript copy, search index, archive/tag store, audit log, durable replay log, or daemon-owned registry database.

Endpoint examples:

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
      "enabled": true,
      "bind": "127.0.0.1",
      "port": 8765,
      "authTokenEnv": "PI_THREADS_AUTH_TOKEN",
      "allowedOrigins": ["https://example.test"],
      "tls": {
        "ca": "/path/ca.pem",
        "cert": "/path/cert.pem",
        "key": "/path/key.pem"
      }
    }
  },
  "servers": {
    "local": { "endpoint": "unix:///tmp/pi-threads.sock" },
    "tcp": {
      "endpoint": "wss://127.0.0.1:8765",
      "authTokenEnv": "PI_THREADS_AUTH_TOKEN",
      "tlsCa": "/path/ca.pem"
    }
  }
}
```

When using `--server ALIAS`, the CLI inherits that alias's `authToken`,
`authTokenEnv`, and `tlsCa` unless an explicit global flag overrides it.

## Architecture

The core service owns session catalog lookup, worker scheduling, leases, event fanout, active turn state, external-writer checks, and worker adaptation. CLI rendering and JSON-RPC transports are adapters over the same service methods.

Workers are cwd-aware. A new thread for cwd `X` uses an idle worker already rooted at `X` or spawns a new worker in `X`. Existing sessions can be loaded into idle workers with internal `switch_session`. The daemon enforces one in-memory writer lease per Pi session id.

`daemon.worker.minWorkers` prewarms and maintains that many total workers rooted at the daemon process cwd. The default is `0`; set it to `1` for a warm local worker. `daemon.worker.idleTtlMs` reaps non-running workers after the configured idle time, trimming the pool down to `minWorkers`. The default is five minutes.

External writer detection is best-effort. The daemon samples session file size, mtime, and last-entry identity before write-producing commands and refuses with `externalWriterDetected` if the baseline changed outside daemon-owned execution. Direct Pi use still has a TOCTOU window because Pi does not share a lock with this daemon.

## Transports And Security

- Unix socket JSON-RPC JSONL is the default local transport.
- stdio JSON-RPC JSONL is available via `pi-threads daemon start --stdio` for embedding.
- WebSocket JSON-RPC is opt-in through config.
- Non-loopback TCP requires TLS cert/key and bearer token auth.
- TCP/WebSocket auth uses static bearer tokens from config or env.
- WebSocket Origin validation is supported through `allowedOrigins`.
- Cookie or ambient browser auth is intentionally not used.

TCP access is shell-equivalent capability because Pi can execute commands and mutate files. Treat tokens and TLS keys accordingly.

## Tests And Smoke

```bash
bun run typecheck
bun run lint
bun run test
bun run check
bun run smoke:mock
bun run smoke:live
```

`smoke:mock` is deterministic and non-costing. `smoke:live` uses real Pi workers and real model turns by default, including `new`, `send`, `status`, `messages`, `steer`, `abort`, and concurrent multi-worker proof. Use `PI_THREADS_MODEL` and `PI_THREADS_THINKING` to pin a model; otherwise the smoke inherits Pi's configured default model.

## Build And Release

```bash
bun run build
bun run build:exe
bun run build:exe:linux-x64
bun run build:exe:macos-arm64
bun run build:exe:macos-x64
bun run verify
bun run release -- patch
```

Release readiness includes clean `main`, synced remote, `bun run verify`, release notes with the tested Pi range, and live smoke status for non-costing, costing, and parallel-worker paths.

## Compatibility Matrix

| pi-threads | Tested Pi | Status |
|---|---|---|
| 0.1.x | 0.75.5, 0.75.x protocol range | Initial supported range |

## Known Limitations

- No daemon-owned archive, tags, audit log, durable event replay, search database, or transcript projection.
- Active Pi work is not recovered after daemon restart; startup is a cold rescan of Pi session files.
- External-writer detection is best-effort and cannot eliminate races with direct Pi use.
- Usage and provider attribution are best-effort and depend on the Pi RPC/session surfaces available in the supported version.
- Raw TCP JSONL is not enabled; WebSocket is the TCP transport.
