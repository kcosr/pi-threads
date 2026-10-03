# Changelog

## [Unreleased]

### Breaking Changes

- Require Pi 1.0.x (tested with 1.0.0); remove Pi 0.x worker compatibility.
  The pinned Pi dependency now requires Node.js 22.19 or newer.

### Added

- Add `smoke:pi`, exercising the actual Pi 1.0 CLI against a local model
  fixture with isolated settings and sessions, without provider calls.

- Added Pi's `max` thinking level to configuration and CLI validation.
  ([#2](https://github.com/kcosr/pi-threads/pull/2))

### Changed

- Update the pinned Pi protocol/runtime dependency to 1.0.0.

### Fixed

- Honor Pi 1.0 prompt, steer, and follow-up dispositions so extension-handled
  input does not leave turns waiting or incorrectly report queued work.
- Settle runs only on `agent_settled`, preserve turn identity during retries,
  and emit one terminal event on abort or worker failure.
- Wait for session-baseline refresh before subsequent writes, and serialize
  session mutations so daemon-owned changes do not trigger external-writer errors.
- Preserve mutation results and original errors when subsequent session metadata
  refresh fails; report the refresh failure separately as a diagnostic event.
- Distinguish tool progress (`tool.updated`) from tool completion.
- Release capacity after failed worker startup; report missing executables
  and terminate workers after ambiguous RPC timeouts. Repeated crashes of
  prewarmed workers use bounded exponential recovery delays.
- Make blocking CLI work fail on failed/aborted turns and lost daemon
  connections; share one client connection across concurrent requests.
- Refresh session metadata, reject deleted cached sessions, resolve new
  unpersisted sessions, expand Pi directory tildes, and honor `last: 0`.
- Refuse active socket paths and ordinary files at startup, clean up partial
  daemon startup, and close client connections during shutdown.
- Handle WebSocket message boundaries, clean up disconnected subscriptions,
  and prevent clients from removing another connection's subscriptions.
- Validate worker limits as integers and reject invalid timeout values.

- Compiled clients now apply configured `tlsCa` files through an HTTPS agent,
  preserving per-server private CA trust for `wss://` aliases under Bun.
  ([#2](https://github.com/kcosr/pi-threads/pull/2))
- WebSocket Origin validation now treats an empty `allowedOrigins` list as
  browser-deny-by-default while continuing to allow non-browser clients that
  send no Origin header.
  ([#2](https://github.com/kcosr/pi-threads/pull/2))
- Workers wait for `agent_settled` before completing or
  releasing a daemon turn, so retries, compaction retries, and queued
  continuations retain thread ownership until Pi is fully settled.
  ([#2](https://github.com/kcosr/pi-threads/pull/2))

## [0.1.0] - 2026-07-09

### Breaking Changes

### Added

- Initial `pi-threads` daemon, CLI, worker-pool, transport, client, test, and smoke scaffold.
- Worker pool `minWorkers` prewarming and `idleTtlMs` idle reaping.
- Shell completion commands for bash, zsh, and fish.
- `list` and `search` filters for `--since`, `--sort`, `--asc`, `--desc`, and `--cursor`.
- Config-level `defaults.model` and `defaults.thinking` for new Pi sessions.
- Verified standalone archives for Linux x86_64/arm64 and macOS x86_64/arm64,
  with checksums and GitHub Release publishing.
- Direct ownership guidance: use `pi-threads` exclusively while it controls a
  session; native Pi must not access that same session concurrently.

### Changed

- Live smoke now runs real Pi/model turns by default, including send, steer, abort, and parallel worker validation.
- Human CLI output now uses padded tables and key-value rows instead of TSV-style rows.
- Default `new` and `send` waits no longer print raw daemon event lines; explicit `--stream` keeps filtered event progress.
- `--server` aliases now inherit configured bearer auth and TLS CA settings.
- `server/status` now reports active daemon transport names.
- Pi session catalog now reads session JSONL directly without importing the Pi runtime, and supports Pi versions 0.75.x through 0.80.x. ([#1](https://github.com/kcosr/pi-threads/pull/1))
- Pi worker startup now gives `pi --version` up to 15 seconds and disables Pi startup network checks for version probes and RPC workers unless explicitly overridden. ([#1](https://github.com/kcosr/pi-threads/pull/1))
- Provider-prefixed model names now resolve against Pi's available-model catalog. ([#1](https://github.com/kcosr/pi-threads/pull/1))

### Fixed

- `--tls-ca` now configures the WebSocket client TLS CA instead of being parsed only.
- Non-loopback WebSocket startup now requires bearer token auth in addition to TLS.

### Removed

- Removed unused client certificate flags and server-alias fields for mTLS.
