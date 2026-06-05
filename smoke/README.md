# pi-threads Smoke

`smoke:mock` is deterministic and uses a generated fake `pi` executable. It starts a disposable daemon over a Unix socket and exercises representative CLI commands without model calls.

`smoke:live` is opt-in and targets real `pi --mode rpc` workers. By default it avoids model-costing turns and uses disposable directories.

Environment flags:

- `PI_THREADS_ENDPOINT`: endpoint to target, default `unix:///tmp/pi-threads-live.sock`.
- `PI_THREADS_TRANSPORT=stdio`: reserved for parent-owned daemon smoke.
- `PI_THREADS_AUTH_TOKEN_ENV`: token env var for TCP/WebSocket smoke.
- `PI_THREADS_TLS_CA`: CA path for `wss://` smoke.
- `RUN_PI_TURN=1`: allow real model prompts that may spend tokens.
- `RUN_PI_PARALLEL=1`: prove distinct cwd sessions can run concurrently.
- `RUN_PI_ABORT=1`, `RUN_PI_BASH=1`, `RUN_PI_FORK=1`, `RUN_PI_EXTERNAL_WRITER=1`: enable scoped destructive or tooling paths in disposable dirs.

The live harness cleans up temporary config, socket, and work directories it creates. It does not intentionally operate on user project files unless the caller points it at an existing daemon or workdir.
