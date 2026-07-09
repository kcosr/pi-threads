# pi-threads

`pi-threads` is a standalone daemon and CLI for supervising a pool of
single-session `pi --mode rpc` workers.

Pi remains the execution engine. Pi session JSONL files remain the durable
transcript source of truth. `pi-threads` adds a thread-aware control surface for
listing sessions, creating and sending turns, steering or aborting active work,
reading messages, exporting transcripts, and multiplexing multiple Pi workers
through local transports.

This repository is not a Pi modification. It starts external Pi RPC
subprocesses, keeps daemon state in memory, and exposes Unix socket, stdio, and
opt-in secured WebSocket JSON-RPC transports over one core service API.

## How It Works

`pi-threads` runs a long-lived daemon that manages a pool of Pi `--mode rpc`
subprocesses. CLI commands connect to that daemon; it reserves a worker for the
requested thread or starts one for a new session. A worker is leased to one
active thread at a time, then returned to the idle pool or reaped.

Pi remains the execution engine and owns the session JSONL. `pi-threads` adds
only the in-memory scheduling, worker lifecycle, local transports, and
thread-oriented control surface. Restarting the daemon drops that in-memory
control state but does not remove existing Pi sessions.

While `pi-threads` controls a thread, use `pi-threads` to interact with it. Do
not start, resume, or otherwise use the same session with native Pi
concurrently. Pi does not share a lock with this daemon, so concurrent native
Pi access can race the worker and session state; stop the thread or daemon
first.

## Features

- JSON configuration for daemon worker limits, default model/thinking settings,
  and named client endpoints.
- Local Unix socket daemon transport by default.
- Parent-owned stdio daemon transport for embedding.
- Opt-in WebSocket transport with bearer-token auth, Origin checks, and TLS
  requirements for non-loopback binds.
- Cwd-aware worker scheduling for new Pi sessions.
- In-memory worker pool with configurable `minWorkers`, `maxWorkers`, and idle
  reaping down to `minWorkers`.
- Thread list, search, detail, status, and flattened message history commands.
- Prompted `new` and `send` commands that wait by default, can stream progress,
  and support JSON final output or NDJSON event streams.
- Default model and thinking configuration for new Pi sessions.
- Active-turn `steer`, `follow-up`, and `abort`.
- Pi session `fork`, `clone`, `name`, `settings`, `models`, `usage`,
  `commands`, `stats`, `compact`, `bash`, and `export-html` commands.
- Shell completions for bash, zsh, and fish.
- Mock smoke and opt-in live smoke harnesses.
- Standalone Bun executable builds for local use and release archives.

## Install

Download the latest archive for your platform from GitHub Releases:

```text
https://github.com/kcosr/pi-threads/releases
```

Supported release platforms are currently:

- `linux-x86_64`
- `linux-arm64`
- `macos-arm64`
- `macos-x86_64`

Verify the archive against the accompanying `SHA256SUMS` file, extract it, and
install the enclosed `pi-threads` binary somewhere on your `PATH`:

```bash
tar -xzf pi-threads-<version>-linux-x86_64.tar.gz
mkdir -p ~/.local/bin
install -m 755 pi-threads-<version>-linux-x86_64/pi-threads ~/.local/bin/pi-threads
pi-threads --help
```

`pi-threads` requires the Pi CLI/runtime separately. Ensure the `pi` executable
is on `PATH`, or set `PI_THREADS_PI_BIN=/path/to/pi` for daemon and smoke
commands. Worker startup probes `pi --version` with a 15 second timeout and
sets Pi's startup network opt-outs for the probe and RPC workers
(`PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`) unless those
environment variables are already set.

For unsupported platforms or local development, build from source in the
Development section near the end of this document.

## Quickstart

Create a config:

```bash
mkdir -p ~/.config/pi-threads
cp config.example.json ~/.config/pi-threads/config.json
```

Example local config:

```json
{
  "defaults": {
    "model": "provider/modelId",
    "thinking": "medium"
  },
  "daemon": {
    "unixSocket": "/var/run/user/1000/pi.sock",
    "worker": {
      "minWorkers": 0,
      "maxWorkers": 4,
      "idleTtlMs": 300000
    },
    "tcp": {
      "enabled": false,
      "bind": "127.0.0.1",
      "port": 8765,
      "authTokenEnv": "PI_THREADS_AUTH_TOKEN",
      "allowedOrigins": []
    }
  },
  "servers": {
    "local": {
      "endpoint": "unix:///var/run/user/1000/pi.sock"
    }
  }
}
```

Start the daemon in one shell:

```bash
pi-threads daemon start
```

Use another shell for client commands:

```bash
pi-threads servers ping
pi-threads list --cwd "$PWD" --since 24h --limit 20
pi-threads new --cwd "$PWD" --name demo "Summarize this project"
```

For ad hoc use without a config file, point the client directly at a socket:

```bash
pi-threads --config ./config.json daemon start
pi-threads --config ./config.json servers ping
pi-threads --connect unix:///tmp/pi-threads.sock list
```

When more than one server alias is configured, select one explicitly:

```bash
pi-threads --server local servers ping
pi-threads --server local new --cwd "$PWD" "Run the tests"
```

Successful `servers ping` human output is tabular:

```text
VERSION  UPTIME   WORKERS  TRANSPORTS
0.1.0    2.1s     0        unix
```

## Starting The Daemon

Default local daemon:

```bash
pi-threads daemon start
```

Daemon with a specific config:

```bash
pi-threads --config /path/to/config.json daemon start
```

Parent-owned stdio daemon for embedding:

```bash
pi-threads daemon start --stdio
```

Stop a daemon through its configured endpoint:

```bash
pi-threads daemon stop
```

Check daemon status:

```bash
pi-threads daemon status
pi-threads status
```

The daemon stays in the foreground. Run it under your shell, a terminal
multiplexer, systemd user service, or another process supervisor.

## Common Workflows

Find recent candidate threads, then inspect one:

```bash
pi-threads list --since 24h --limit 20 --json
pi-threads search "release process" --since 7d --limit 10 --json
pi-threads messages THREAD_ID --role user --last 10
pi-threads show THREAD_ID --last 8 --items summary --json
```

Create a new Pi session and wait for the first turn:

```bash
pi-threads new --cwd "$PWD" "Run the tests" --stream
```

Queue a new session without waiting:

```bash
pi-threads --json --no-wait new --cwd "$PWD" "Inspect this repository"
```

Send a follow-up turn:

```bash
pi-threads send THREAD_ID "Fix the failing test" --stream
```

Adjust an active turn:

```bash
pi-threads steer THREAD_ID "Prefer the smallest targeted fix"
pi-threads follow-up THREAD_ID "Then update the docs"
pi-threads abort THREAD_ID
```

Inspect and update Pi session settings:

```bash
pi-threads settings show THREAD_ID
pi-threads settings set THREAD_ID --thinking high --steering-mode all
pi-threads models
pi-threads models --provider openai
```

Run Pi RPC utilities through the assigned worker:

```bash
pi-threads commands THREAD_ID
pi-threads stats THREAD_ID
pi-threads compact THREAD_ID "Keep implementation decisions"
pi-threads bash THREAD_ID "pwd && git status --short"
pi-threads export-html THREAD_ID out.html
```

Fork, clone, and rename sessions:

```bash
pi-threads fork THREAD_ID --entry-id ENTRY_ID --name forked
pi-threads clone THREAD_ID --name cloned
pi-threads name THREAD_ID "new name"
```

## Configuration

Default config path:

```text
~/.config/pi-threads/config.json
```

Config path precedence:

1. `--config PATH`
2. `~/.config/pi-threads/config.json`
3. Built-in defaults when no config file exists

Server target precedence for client commands:

1. `--connect unix:///path/to.sock`, `--connect ws://host:port`, or
   `--connect wss://host:port`
2. `--server ALIAS`
3. The configured `local` server alias
4. The daemon Unix socket from config
5. Built-in default `unix:///tmp/pi-threads.sock`

`--connect` bypasses configured servers. When using `--server ALIAS`, the CLI
inherits that alias's `authToken`, `authTokenEnv`, and `tlsCa` unless an
explicit global auth/TLS flag overrides it.

Daemon worker fields:

| Field | Purpose |
| --- | --- |
| `daemon.unixSocket` | Unix socket path for the default local daemon transport. |
| `daemon.worker.minWorkers` | Number of workers to prewarm and maintain. Default `0`. |
| `daemon.worker.maxWorkers` | Maximum worker processes. Default `4`; minimum `1`. |
| `daemon.worker.idleTtlMs` | Idle time before non-running workers are reaped down to `minWorkers`. Default `300000`. |
| `daemon.tcp.enabled` | Enable WebSocket JSON-RPC transport. Default `false`. |
| `daemon.tcp.bind` | WebSocket bind address. Default `127.0.0.1`. |
| `daemon.tcp.port` | WebSocket port. Default `8765`. |
| `daemon.tcp.authToken` | Inline bearer token. Prefer `authTokenEnv` on shared systems. |
| `daemon.tcp.authTokenEnv` | Environment variable containing the bearer token. |
| `daemon.tcp.allowedOrigins` | Allowed WebSocket Origin values. Empty allows no browser origins. |
| `daemon.tcp.tls.ca` | Reserved server CA field; it does not enable client-certificate/mTLS authorization today. |
| `daemon.tcp.tls.cert` | TLS certificate path. Required with `key` for TLS. |
| `daemon.tcp.tls.key` | TLS private key path. Required with `cert` for TLS. |

Server alias fields:

| Field | Purpose |
| --- | --- |
| `endpoint` | `unix://`, `ws://`, or `wss://` endpoint. |
| `authToken` | Inline bearer token for WebSocket endpoints. Prefer `authTokenEnv`. |
| `authTokenEnv` | Environment variable containing the bearer token. |
| `tlsCa` | CA file used by the client for `wss://` endpoints. |

New-session defaults:

1. `new --model MODEL` and `new --thinking LEVEL`
2. `defaults.model` and `defaults.thinking`
3. Pi's configured/default provider, model, and thinking settings

Follow-up `send` commands keep the thread's current Pi settings unless
`--model` or `--thinking` is passed explicitly.

`defaults.model` accepts either `provider/modelId` or a model id/name that can
be resolved from Pi's model list. Accepted thinking levels are `off`,
`minimal`, `low`, `medium`, `high`, and `xhigh`.

## Commands

| Command | Purpose |
| --- | --- |
| `daemon start [--stdio]` | Start the foreground daemon over Unix socket and optional stdio. |
| `daemon status [--json]` | Show daemon status, worker count, and transports. |
| `daemon stop [--json]` | Ask the daemon to shut down. |
| `servers [--json]` | List configured server aliases without connecting. |
| `servers ping [--json]` | Connect to the selected daemon and report reachability. |
| `list` | List Pi sessions with `--limit`, `--cursor`, `--since`, `--cwd`, `--sort updated|created`, `--asc`, `--desc`. |
| `search QUERY` | Search Pi sessions with the same list filters. |
| `show THREAD_ID` | Show thread detail and JSONL entries with `--last`, `--asc`, `--desc`, `--items summary|full|none`. |
| `messages THREAD_ID` | Flatten messages with `--last`, `--since`, and `--role user|assistant|tool|bash|custom`. |
| `new [PROMPT]` | Create a Pi session with `--cwd`, `--name`, `--model`, `--thinking`, `--stream`, `--no-wait`, and `--json`. |
| `send THREAD_ID PROMPT` | Start a follow-up turn with optional `--model`, `--thinking`, `--stream`, `--no-wait`, and `--json`. |
| `steer THREAD_ID PROMPT` | Send steering input to an active turn. |
| `follow-up THREAD_ID PROMPT` | Queue follow-up input for the active turn. |
| `abort THREAD_ID` | Abort the active turn. |
| `status [THREAD_ID]` | Show daemon-wide loaded status or one thread status. |
| `fork THREAD_ID --entry-id ENTRY_ID` | Fork a Pi session at a JSONL entry, optionally with `--name`. |
| `clone THREAD_ID` | Clone a Pi session, optionally with `--name`. |
| `name THREAD_ID NAME` | Rename a Pi session. |
| `settings show THREAD_ID` | Read Pi session settings. |
| `settings set THREAD_ID` | Update `--model`, `--thinking`, `--steering-mode`, `--follow-up-mode`, `--auto-compaction`, or `--auto-retry`. |
| `models [--provider PROVIDER]` | List available Pi models. |
| `usage [THREAD_ID]` | Show best-effort usage/account information. |
| `commands THREAD_ID` | List Pi slash/tool commands exposed by the worker. |
| `stats THREAD_ID` | Show best-effort context/session stats. |
| `compact THREAD_ID [PROMPT]` | Run Pi compaction. |
| `bash THREAD_ID COMMAND` | Run a Pi bash command through the assigned worker. |
| `export-html THREAD_ID [OUTPUT]` | Export a Pi session to HTML. |
| `completion [SHELL]` | Print shell completion setup instructions for `bash`, `zsh`, or `fish`. |

Global options `--config PATH`, `--connect ENDPOINT`, `--server ALIAS`,
`--json`, `--stream`, `--no-wait`, `--auth-token TOKEN`,
`--auth-token-env ENV`, and `--tls-ca PATH` are safest before the subcommand,
for example `pi-threads --server local list`.

`list`, `search`, and `messages` accept `--since` as epoch seconds, an ISO
timestamp, or a relative duration ending in `ms`, `s`, `m`, `h`, `d`, or `w`,
such as `500ms`, `5m`, `24h`, or `7d`. `--archived` is rejected because
`pi-threads` does not maintain a daemon-owned archive store.

## Shell Completion

Print setup instructions for the detected shell:

```bash
pi-threads completion
pi-threads completion bash
pi-threads completion zsh
pi-threads completion fish
```

Enable completion only for the current shell:

```bash
source <(pi-threads completion script bash)
source <(pi-threads completion script zsh)
pi-threads completion script fish | source
```

For permanent bash setup, generate a static completion file and source it from
`~/.bashrc`:

```bash
mkdir -p ~/.local/share/pi-threads
pi-threads completion script bash > ~/.local/share/pi-threads/completion.bash
printf '\nsource ~/.local/share/pi-threads/completion.bash\n' >> ~/.bashrc
```

For permanent zsh setup:

```bash
mkdir -p ~/.local/share/pi-threads
pi-threads completion script zsh > ~/.local/share/pi-threads/completion.zsh
printf '\nsource ~/.local/share/pi-threads/completion.zsh\n' >> ~/.zshrc
```

For permanent fish setup:

```fish
mkdir -p ~/.config/fish/completions
pi-threads completion script fish > ~/.config/fish/completions/pi-threads.fish
```

Regenerate the completion file after upgrading `pi-threads`.

Completions suggest command names, nested subcommands, option names, static
values such as `--sort updated|created`, `--items summary|full|none`,
`--role user|assistant|tool|bash|custom`, thinking levels, setting modes, shell
names for `completion`, and local configured server aliases for `--server`.
Completion does not connect to the daemon or Pi, so thread IDs, entry IDs, and
remote model IDs are not completed.

## Output

Human output is the default and is intended for terminal use. List and status
commands use aligned tables with headers. Message-oriented commands print
readable blocks.

`--json` emits a single pretty-printed JSON object for read commands,
acknowledgement commands, `--no-wait` turn commands, and blocking turn
commands.

Blocking `new PROMPT --json` and `send --json` include:

- `threadId`
- `turnId`
- `workerId`
- `status`
- `progress`
- `assistantResponses`
- `finalAssistantText`

`--json --stream` is available for prompted `new` and `send`. It emits NDJSON:
one accepted event, zero or more progress events, and one terminal event.

Commands that create or start work always return enough follow-up identifiers:
`threadId`, daemon-local `turnId`, and `workerId`. The daemon `turnId` is scoped
to the accepted Pi agent run and is not a durable Pi transcript id.

Prompted `new` and `send` wait by default until `turn.completed`,
`turn.aborted`, or `turn.failed`. Use `--no-wait` to return after acceptance.
Use `--stream` for filtered human progress for the accepted turn.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Command succeeded, or a blocking turn completed. |
| `1` | Runtime error, daemon error, or a blocking turn failed/aborted. |
| `2` | Usage, argument, validation, or configuration error. |
| `130` | Local Ctrl-C while waiting on a command. The remote Pi turn may still be running. |

`messages` is a convenience projection over Pi messages. It applies `--since`
and `--role` first, then applies `--last N` to the filtered result.

Use `--json` when exact values are required. Human output may shorten long text
to keep tables readable.

## Architecture

The core service owns session catalog lookup, worker scheduling, leases, event
fanout, active turn state, external-writer checks, and worker adaptation. CLI
rendering and JSON-RPC transports are adapters over the same service methods.

Workers are cwd-aware. A new thread for cwd `X` uses an idle worker already
rooted at `X` or spawns a new worker in `X`. Existing sessions can be loaded
into idle workers with internal `switch_session`. The daemon enforces one
in-memory writer lease per Pi session id.

`daemon.worker.minWorkers` prewarms and maintains that many total workers rooted
at the daemon process cwd. The default is `0`; set it to `1` for a warm local
worker. `daemon.worker.idleTtlMs` reaps non-running workers after the configured
idle time, trimming the pool down to `minWorkers`. The default is five minutes.

External writer detection is best-effort. For sessions the daemon has written
during the current process lifetime, it records session file size, mtime, and
last-entry identity, then refuses later write-producing commands with
`externalWriterDetected` if that baseline changed outside daemon-owned
execution. Freshly discovered sessions do not have this protection until the
daemon records a baseline. This detection is not a coordination mechanism:
never use native Pi concurrently with a thread controlled by `pi-threads`.

## Transports And Security

- Unix socket JSON-RPC JSONL is the default local transport.
- stdio JSON-RPC JSONL is available via `pi-threads daemon start --stdio`.
- WebSocket JSON-RPC is opt-in through config.
- Non-loopback WebSocket requires TLS cert/key and bearer token auth.
- TCP/WebSocket auth uses static bearer tokens from config or env.
- WebSocket Origin validation is supported through `allowedOrigins`.
- Cookie or ambient browser auth is intentionally not used.

TCP access is shell-equivalent capability because Pi can execute commands and
mutate files. Treat tokens and TLS keys accordingly. Prefer `authTokenEnv` over
literal tokens in config files on shared systems.

## Tests And Smoke

Required checks for source changes:

```bash
bun run typecheck
bun run lint
bun run test
bun run check
```

Mock smoke is deterministic and non-costing:

```bash
bun run smoke:mock
```

Live smoke is opt-in and targets real `pi --mode rpc` workers with real model
turns:

```bash
bun run smoke:live
```

`smoke:live` validates daemon startup, model discovery, `new`, `send`,
`status`, `messages`, `steer`, `abort`, cwd-specific worker assignment, and
concurrent multi-worker execution. Use `PI_THREADS_MODEL` and
`PI_THREADS_THINKING` to pin a model; otherwise the smoke inherits Pi's
configured/default provider and model.

See `smoke/README.md` for live smoke flags, cleanup behavior, and token-costing
notes.

## Development

Install dependencies:

```bash
bun install
```

Run the TypeScript entrypoint directly during development:

```bash
bun run src/index.ts servers ping
```

Build a bundled JavaScript output:

```bash
bun run build
```

Build a standalone executable:

```bash
bun run build:exe
./bin/pi-threads --help
```

To use that local build like a release binary, install it somewhere on your
`PATH`:

```bash
mkdir -p ~/.local/bin
install -m 755 bin/pi-threads ~/.local/bin/pi-threads
```

Required release-oriented validation:

```bash
bun run verify
```

`bun run check` runs typecheck, Biome lint, and unit tests. `bun run verify`
adds mock smoke plus bundle and executable builds.

## Release

Releases are driven from `package.json` and `CHANGELOG.md`. `0.1.0` is the
first release version for this repository.

For the first release, after the `Unreleased` changelog section is complete and
`main` is clean and synced:

```bash
node scripts/release.mjs current
```

For later releases, use `patch`, `minor`, `major`, or an explicit semantic
version:

```bash
node scripts/release.mjs patch
node scripts/release.mjs minor
node scripts/release.mjs major
node scripts/release.mjs 0.2.3
```

The script verifies a clean, synchronized `main`, validates the source and
both source and standalone-binary mock smokes, creates and pushes `vX.Y.Z`,
builds all supported archives from the tag, verifies their contents and
checksums, and publishes the GitHub Release. The generated archive layout is:

```text
pi-threads-VERSION-PLATFORM/
  pi-threads
  README.md
  LICENSE
  CHANGELOG.md
  config.example.json
  smoke/README.md
  docs/
```

## Compatibility Matrix

| pi-threads | Tested Pi | Status |
| --- | --- | --- |
| 0.1.x | 0.75.x through 0.80.x | Initial supported range |

## Known Limitations

- No daemon-owned archive, tags, audit log, durable event replay, search
  database, or transcript projection.
- Active Pi work is not recovered after daemon restart; startup is a cold
  rescan of Pi session files.
- Threads controlled by `pi-threads` must not be used through native Pi at the
  same time. External-writer detection is best-effort and cannot prevent those
  races.
- Usage and provider attribution are best-effort and depend on the Pi
  RPC/session surfaces available in the supported version.
- Raw TCP JSONL is not enabled; WebSocket is the TCP transport.

## Project Structure

- `src/cli/` - command parser, runtime, rendering, and completions.
- `src/service/` - core service, event bus, and daemon method orchestration.
- `src/session/` - Pi session catalog and JSONL reads.
- `src/transport/` - Unix socket, stdio, and WebSocket adapters.
- `src/worker/` - Pi RPC worker and worker pool.
- `test/` - focused unit and integration-style tests.
- `smoke/` - mock and opt-in live smoke harnesses.
- `docs/` - implementation audits and parity notes.
- `scripts/` - release automation.
