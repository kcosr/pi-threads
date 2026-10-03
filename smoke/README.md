# pi-threads Smoke

`smoke:mock` is deterministic and uses a generated fake Pi 1.0 executable that emits `agent_settled` and prompt dispositions. It starts a disposable daemon over a Unix socket and exercises representative CLI commands without model calls, including a prompted `new` check that default output does not leak raw daemon event names.

`smoke:pi` runs the pinned Pi 1.0.0 executable from `node_modules/.bin/pi`
against an HTTP model fixture bound to loopback. Disposable Pi settings,
extensions, and sessions keep it independent of user configuration. It checks
promptless sessions, extension-handled input, real prompt completion, session
schema, settings and shell mutations, compaction, follow-up disposition, abort,
failure, and recovery after killing a fixture worker. It makes no provider calls
and is included in `bun run verify`. Run `bun install` first.

The unit lifecycle suite also covers metadata-refresh failures after both
successful and failed session mutations, ensuring their original outcomes survive.

`smoke:live` is opt-in and targets real `pi --mode rpc` workers with real model turns. It uses disposable directories and validates daemon startup, model discovery, `new`, `send`, `status`, `messages`, `steer`, `abort`, cwd-specific worker assignment, and concurrent multi-worker execution.

Environment flags:

- `PI_THREADS_ENDPOINT`: endpoint to target, default `unix:///tmp/pi-threads-live.sock`.
- `PI_THREADS_TRANSPORT=stdio`: reserved for parent-owned daemon smoke.
- `PI_THREADS_AUTH_TOKEN_ENV`: reserved for future TCP/WebSocket smoke.
- `PI_THREADS_TLS_CA`: reserved for future `wss://` smoke.
- `PI_THREADS_MODEL`: optional model selector. Use `provider/modelId` for an exact Pi RPC `set_model`, or a configured Pi model id that can be resolved from `get_available_models`.
- `PI_THREADS_THINKING`: optional thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

Current live smoke always runs real model turns and includes abort coverage. `RUN_PI_BASH=1`, `RUN_PI_FORK=1`, and `RUN_PI_EXTERNAL_WRITER=1` are design-era optional paths that are not wired into the current script; see `docs/config-option-implementation-audit.md`.

Real live smoke may spend provider tokens. Use `smoke:mock` for fake-worker coverage or `smoke:pi` for no-cost real-Pi coverage.

The live harness cleans up temporary config, socket, and work directories it creates. It does not intentionally operate on user project files unless the caller points it at an existing daemon or workdir.

## Event and stream regressions

`bun run check` includes cursor expiry/restart, nested event ordering, replay
reentrancy, immediate turn completion, exact-turn filtering, observer cleanup,
and bounded stream buffering tests. These tests do not invoke a model provider.
