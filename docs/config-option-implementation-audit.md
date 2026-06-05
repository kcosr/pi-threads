# Config And Option Implementation Audit

Date: 2026-06-05

This audit covers configurable and documented parameters in `README.md`,
`DESIGN.md`, `config.example.json`, `smoke/README.md`, and source. It avoids
proposing any daemon metadata database, transcript copy, durable event replay, or
other storage outside the project design.

## Implemented

| Parameter or option | Current status |
| --- | --- |
| `daemon.unixSocket` | Used by daemon startup and Unix JSON-RPC listener. |
| `daemon.worker.maxWorkers` | Enforced by `WorkerPool`; excess requests fail with `capacity`. |
| `daemon.worker.minWorkers` | Prewarms and maintains a minimum total worker count. |
| `daemon.worker.idleTtlMs` | Reaps idle or assigned non-running workers down to `minWorkers`. |
| `daemon.tcp.enabled`, `bind`, `port` | Starts the optional WebSocket JSON-RPC listener. |
| `daemon.tcp.authToken`, `authTokenEnv` | Enforced on WebSocket connections when configured. |
| `daemon.tcp.allowedOrigins` | Enforced for WebSocket requests that include `Origin`. |
| `daemon.tcp.tls.cert`, `daemon.tcp.tls.key` | Used for HTTPS/WSS when both values are present; required for non-loopback binds. |
| Non-loopback TCP bearer-token requirement | Non-loopback WebSocket startup requires a resolved bearer token as well as TLS. |
| `servers.*.endpoint` | Used by `--server ALIAS` to select the daemon endpoint. |
| `servers.*.authToken`, `servers.*.authTokenEnv` | Inherited when `--server ALIAS` is used; explicit CLI token flags override alias config. |
| `servers.*.tlsCa` | Inherited when `--server ALIAS` is used and passed to the WebSocket TLS client. |
| `defaults.model` | Applied to new Pi sessions when `new` omits `--model`. Existing-thread sends inherit current thread settings unless `--model` is explicit. |
| `defaults.thinking` | Applied to new Pi sessions when `new` omits `--thinking`; validated against Pi thinking levels. Existing-thread sends inherit current thread settings unless `--thinking` is explicit. |
| `--config`, `--connect`, `--server`, `--json`, `--stream`, `--no-wait` | Implemented for CLI requests and work-starting commands. |
| `--auth-token`, `--auth-token-env` | Passed to the WebSocket client as bearer auth. |
| `--tls-ca` | Passed to the WebSocket TLS client as a private CA path. |
| `new/send/settings set --model` | Implemented as `provider/modelId` or configured Pi model id/name lookup. |
| `new/send/settings set --thinking` | Validated by CLI and sent as Pi `set_thinking_level`. |
| `list/search` read filters | `--since`, `--sort`, `--asc`, `--desc`, `--cursor`, `--limit`, and `--cwd` are implemented. |
| `show` read shaping | `--last`, `--asc`, `--desc`, and `--items summary\|full\|none` are implemented. |
| `messages` filters | `--last`, `--since`, and role filtering are implemented for loaded and catalog-backed sessions. |
| `settings set` modes and booleans | Queue modes and boolean states are validated by CLI choices. |
| Shell completions | Bash, zsh, and fish scripts plus hidden completion candidates are implemented. |
| `server/status` transport list | Runtime transport names are stored in the service and returned by daemon status. |
| `PI_THREADS_MODEL`, `PI_THREADS_THINKING` live smoke env vars | Implemented for live smoke model and thinking overrides. |

## Remaining Gaps Or Deferred Surfaces

| Parameter or option | Current status | Next action |
| --- | --- | --- |
| `daemon.tcp.tls.ca` | Passed to HTTPS server options, but the server does not request client certificates. | Document as a server certificate-chain option or remove/defer if intended for mTLS. |
| `PI_THREADS_TRANSPORT=stdio` | Reserved in smoke docs; no stdio smoke harness is wired. | Add a dedicated parent-owned stdio smoke harness or keep marked reserved. |
| `PI_THREADS_AUTH_TOKEN_ENV`, `PI_THREADS_TLS_CA` live smoke flags | Reserved for future WebSocket smoke; not read by the current live script. | Implement with WebSocket/TLS live smoke before marking active. |
| `RUN_PI_BASH=1`, `RUN_PI_FORK=1`, `RUN_PI_EXTERNAL_WRITER=1` | Design-era optional smoke flags, not wired into current script. | Implement optional sections or keep documented as deferred. |

## Notes

- `--archived` is intentionally rejected for `list` and `search` because
  `pi-threads` does not maintain archive/tag metadata.
- Default work-starting commands now wait quietly; explicit `--stream` scopes
  event output to the accepted turn, and `--json --stream` emits NDJSON records.
- Worker state `assigned` means loaded and idle; only worker state `running` or
  an active daemon turn makes thread status `running`.
- Client certificate/mTLS fields are intentionally absent from CLI and server
  alias config. Add them only if an explicit mTLS design is accepted.
