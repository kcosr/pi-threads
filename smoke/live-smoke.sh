#!/usr/bin/env bash
set -euo pipefail

ENDPOINT="${PI_THREADS_ENDPOINT:-unix:///tmp/pi-threads-live.sock}"
TMPDIR="$(mktemp -d)"
CONFIG="$TMPDIR/config.json"
WORKDIR="$TMPDIR/work"
mkdir -p "$WORKDIR"

cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

cat >"$CONFIG" <<EOF
{
  "daemon": {
    "unixSocket": "${ENDPOINT#unix://}",
    "worker": {
      "minWorkers": ${PI_THREADS_MIN_WORKERS:-0},
      "maxWorkers": ${PI_THREADS_MAX_WORKERS:-4},
      "idleTtlMs": 300000
    }
  },
  "servers": {
    "local": {
      "endpoint": "$ENDPOINT"
    }
  }
}
EOF

pi --version >/dev/null

if [[ -z "${PI_THREADS_ENDPOINT:-}" || "$ENDPOINT" == unix://* ]]; then
  bun run src/index.ts --config "$CONFIG" daemon start &
  DAEMON_PID=$!
  trap 'kill "$DAEMON_PID" 2>/dev/null || true; cleanup' EXIT
  sleep 1
fi

bun run src/index.ts --config "$CONFIG" --connect "$ENDPOINT" servers ping
bun run src/index.ts --config "$CONFIG" --connect "$ENDPOINT" models
bun run src/index.ts --config "$CONFIG" --connect "$ENDPOINT" --no-wait new --cwd "$WORKDIR" --name live-smoke
bun run src/index.ts --config "$CONFIG" --connect "$ENDPOINT" list --cwd "$WORKDIR"

if [[ "${RUN_PI_TURN:-0}" == "1" ]]; then
  THREAD_JSON="$(bun run src/index.ts --config "$CONFIG" --connect "$ENDPOINT" --json --no-wait new --cwd "$WORKDIR" "Say exactly: live smoke")"
  THREAD_ID="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.threadId)' "$THREAD_JSON")"
  bun run src/index.ts --config "$CONFIG" --connect "$ENDPOINT" status "$THREAD_ID"
  bun run src/index.ts --config "$CONFIG" --connect "$ENDPOINT" messages "$THREAD_ID"
fi

bun run src/index.ts --config "$CONFIG" --connect "$ENDPOINT" daemon stop || true
echo "live smoke completed"
