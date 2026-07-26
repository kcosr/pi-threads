# Changelog

## [Unreleased]

### Added

- Added Pi's `max` thinking level to configuration and CLI validation.
  ([#2](https://github.com/kcosr/pi-threads/pull/2))

### Changed

- Extended worker compatibility through Pi 0.82.x and updated the pinned Pi
  protocol/runtime dependency to 0.82.1.
  ([#2](https://github.com/kcosr/pi-threads/pull/2))

### Fixed

- Compiled clients now apply configured `tlsCa` files through an HTTPS agent,
  preserving per-server private CA trust for `wss://` aliases under Bun.
  ([#2](https://github.com/kcosr/pi-threads/pull/2))
- WebSocket Origin validation now treats an empty `allowedOrigins` list as
  browser-deny-by-default while continuing to allow non-browser clients that
  send no Origin header.
  ([#2](https://github.com/kcosr/pi-threads/pull/2))
- Pi 0.81 and newer workers now wait for `agent_settled` before completing or
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
