# pi-threads Smoke

`smoke:mock` is deterministic and uses a generated fake `pi` executable. It starts a disposable daemon over a Unix socket and exercises representative CLI commands without model calls, including a prompted `new` check that default output does not leak raw daemon event names.

`smoke:live` is opt-in and targets real `pi --mode rpc` workers with real model turns. It uses disposable directories and validates daemon startup, model discovery, `new`, `send`, `status`, `messages`, `steer`, `abort`, cwd-specific worker assignment, and concurrent multi-worker execution.

Environment flags:

- `PI_THREADS_ENDPOINT`: endpoint to target, default `unix:///tmp/pi-threads-live.sock`.
- `PI_THREADS_TRANSPORT=stdio`: reserved for parent-owned daemon smoke.
- `PI_THREADS_AUTH_TOKEN_ENV`: reserved for future TCP/WebSocket smoke.
- `PI_THREADS_TLS_CA`: reserved for future `wss://` smoke.
- `PI_THREADS_MODEL`: optional model selector. Use `provider/modelId` for an exact Pi RPC `set_model`, or a configured Pi model id that can be resolved from `get_available_models`.
- `PI_THREADS_THINKING`: optional thinking level: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.

Current live smoke always runs real model turns and includes abort coverage. `RUN_PI_BASH=1`, `RUN_PI_FORK=1`, and `RUN_PI_EXTERNAL_WRITER=1` are design-era optional paths that are not wired into the current script; see `docs/config-option-implementation-audit.md`.

Real live smoke may spend provider tokens. Use `smoke:mock` for no-cost fake-worker coverage.

The live harness cleans up temporary config, socket, and work directories it creates. It does not intentionally operate on user project files unless the caller points it at an existing daemon or workdir.
