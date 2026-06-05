#!/usr/bin/env bash
set -euo pipefail

ENDPOINT="${PI_THREADS_ENDPOINT:-unix:///tmp/pi-threads-live.sock}"
TMPDIR="$(mktemp -d)"
CONFIG="$TMPDIR/config.json"
WORKDIR="$TMPDIR/work"
MAIN_WORKDIR="$WORKDIR/main"
PARALLEL_A_WORKDIR="$WORKDIR/parallel-a"
PARALLEL_B_WORKDIR="$WORKDIR/parallel-b"
mkdir -p "$MAIN_WORKDIR" "$PARALLEL_A_WORKDIR" "$PARALLEL_B_WORKDIR"

cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

wait_for_socket() {
  local socket_path="$1"
  local timeout="$2"
  local deadline=$((SECONDS + timeout))
  while ((SECONDS < deadline)); do
    if [[ -S "$socket_path" ]]; then
      return 0
    fi
    sleep 0.2
  done
  echo "timed out waiting for daemon socket $socket_path" >&2
  exit 1
}

json_expr() {
  local json="$1"
  local expr="$2"
  printf '%s' "$json" | node -e 'let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => { const value = JSON.parse(input); const result = Function("value", `return ${process.argv[1]}`)(value); if (result !== undefined) console.log(result); });' "$expr"
}

thread_status() {
  local thread_id="$1"
  local status_json
  status_json="$("${CLI[@]}" --json status "$thread_id")"
  json_expr "$status_json" "value.status"
}

wait_for_status() {
  local thread_id="$1"
  local expected="$2"
  local timeout="$3"
  local deadline=$((SECONDS + timeout))
  local observed=""
  while ((SECONDS < deadline)); do
    observed="$(thread_status "$thread_id" || true)"
    if [[ "$observed" == "$expected" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "thread $thread_id did not reach status $expected; last observed: $observed" >&2
  exit 1
}

wait_for_both_running() {
  local left="$1"
  local right="$2"
  local timeout="$3"
  local deadline=$((SECONDS + timeout))
  local left_status=""
  local right_status=""
  while ((SECONDS < deadline)); do
    left_status="$(thread_status "$left" || true)"
    right_status="$(thread_status "$right" || true)"
    if [[ "$left_status" == "running" && "$right_status" == "running" ]]; then
      return 0
    fi
    sleep 0.5
  done
  echo "parallel threads were not observed running together; last statuses: $left_status/$right_status" >&2
  exit 1
}

assert_message_count() {
  local thread_id="$1"
  local minimum="$2"
  local messages_json
  local count
  messages_json="$("${CLI[@]}" --json messages "$thread_id")"
  count="$(json_expr "$messages_json" '(value.messages || []).length')"
  if ((count < minimum)); then
    echo "thread $thread_id has $count messages, expected at least $minimum" >&2
    exit 1
  fi
}

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
  wait_for_socket "${ENDPOINT#unix://}" 30
fi

CLI=(bun run src/index.ts --config "$CONFIG" --connect "$ENDPOINT")
MODEL_ARGS=()
if [[ -n "${PI_THREADS_MODEL:-}" ]]; then
  MODEL_ARGS+=(--model "$PI_THREADS_MODEL")
fi
if [[ -n "${PI_THREADS_THINKING:-}" ]]; then
  MODEL_ARGS+=(--thinking "$PI_THREADS_THINKING")
fi

"${CLI[@]}" --json servers ping >/dev/null
MODELS_JSON="$("${CLI[@]}" --json models)"
MODEL_COUNT="$(json_expr "$MODELS_JSON" '(value.models || []).length')"
if [[ "$MODEL_COUNT" == "0" ]]; then
  echo "models/list returned no configured models" >&2
  exit 1
fi
echo "models ok: $MODEL_COUNT configured"

THREAD_JSON="$("${CLI[@]}" --json --no-wait new --cwd "$MAIN_WORKDIR" --name live-smoke-new "${MODEL_ARGS[@]}" "Reply with exactly: pi-threads live smoke new")"
THREAD_ID="$(json_expr "$THREAD_JSON" 'value.threadId')"
echo "new accepted: $THREAD_ID"
wait_for_status "$THREAD_ID" idle 300
assert_message_count "$THREAD_ID" 1

SEND_JSON="$("${CLI[@]}" --json --no-wait send "$THREAD_ID" "${MODEL_ARGS[@]}" "Reply with exactly: pi-threads live smoke send")"
SEND_TURN_ID="$(json_expr "$SEND_JSON" 'value.turnId')"
echo "send accepted: $SEND_TURN_ID"
wait_for_status "$THREAD_ID" idle 300
assert_message_count "$THREAD_ID" 2

STEER_JSON="$("${CLI[@]}" --json --no-wait send "$THREAD_ID" "${MODEL_ARGS[@]}" "Write a numbered list from 1 to 180. Do not use tools. Keep writing until the list is complete.")"
STEER_TURN_ID="$(json_expr "$STEER_JSON" 'value.turnId')"
wait_for_status "$THREAD_ID" running 90
"${CLI[@]}" --json steer "$THREAD_ID" "Change the remaining answer to a concise final summary and stop after that summary." >/dev/null
echo "steer accepted during turn: $STEER_TURN_ID"
wait_for_status "$THREAD_ID" idle 300

ABORT_JSON="$("${CLI[@]}" --json --no-wait send "$THREAD_ID" "${MODEL_ARGS[@]}" "Write a numbered list from 1 to 500. Do not use tools. Keep writing until the list is complete.")"
ABORT_TURN_ID="$(json_expr "$ABORT_JSON" 'value.turnId')"
wait_for_status "$THREAD_ID" running 90
"${CLI[@]}" --json abort "$THREAD_ID" >/dev/null
echo "abort accepted during turn: $ABORT_TURN_ID"
wait_for_status "$THREAD_ID" idle 180

PARALLEL_A_JSON="$("${CLI[@]}" --json --no-wait new --cwd "$PARALLEL_A_WORKDIR" --name live-parallel-a "${MODEL_ARGS[@]}" "Write a numbered list from 1 to 160 for parallel smoke A. Do not use tools.")"
PARALLEL_B_JSON="$("${CLI[@]}" --json --no-wait new --cwd "$PARALLEL_B_WORKDIR" --name live-parallel-b "${MODEL_ARGS[@]}" "Write a numbered list from 1 to 160 for parallel smoke B. Do not use tools.")"
PARALLEL_A_THREAD="$(json_expr "$PARALLEL_A_JSON" 'value.threadId')"
PARALLEL_B_THREAD="$(json_expr "$PARALLEL_B_JSON" 'value.threadId')"
PARALLEL_A_WORKER="$(json_expr "$PARALLEL_A_JSON" 'value.workerId')"
PARALLEL_B_WORKER="$(json_expr "$PARALLEL_B_JSON" 'value.workerId')"
if [[ "$PARALLEL_A_WORKER" == "$PARALLEL_B_WORKER" ]]; then
  echo "parallel sessions used the same worker: $PARALLEL_A_WORKER" >&2
  exit 1
fi
wait_for_both_running "$PARALLEL_A_THREAD" "$PARALLEL_B_THREAD" 90
echo "parallel running: $PARALLEL_A_THREAD/$PARALLEL_A_WORKER and $PARALLEL_B_THREAD/$PARALLEL_B_WORKER"
wait_for_status "$PARALLEL_A_THREAD" idle 300
wait_for_status "$PARALLEL_B_THREAD" idle 300

"${CLI[@]}" list --cwd "$MAIN_WORKDIR" >/dev/null

"${CLI[@]}" daemon stop || true
echo "live smoke completed"
