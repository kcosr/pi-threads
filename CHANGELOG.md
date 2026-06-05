# Changelog

## [Unreleased]

### Breaking Changes

### Added

- Initial `pi-threads` daemon, CLI, worker-pool, transport, client, test, and smoke scaffold.
- Worker pool `minWorkers` prewarming and `idleTtlMs` idle reaping.
- Shell completion commands for bash, zsh, and fish.
- `list` and `search` filters for `--since`, `--sort`, `--asc`, `--desc`, and `--cursor`.

### Changed

- Live smoke now runs real Pi/model turns by default, including send, steer, abort, and parallel worker validation.
- Human CLI output now uses padded tables and key-value rows instead of TSV-style rows.
- Default `new` and `send` waits no longer print raw daemon event lines; explicit `--stream` keeps filtered event progress.

### Fixed

### Removed
