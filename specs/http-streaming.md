# HTTP and streamed turns

One service implements the existing RPC method/parameter/result contract across
Unix sockets, stdio, WebSocket, and HTTP. Network access stays opt-in through
`daemon.tcp`; one HTTP(S) listener serves HTTP and WebSocket upgrades.

- `POST /rpc` with JSON acceptance returns a single RPC response.
- `POST /rpc` accepting `text/event-stream` supports `thread/start` and
  `thread/send`. Its first SSE `response` frame contains the RPC acceptance
  response, followed by `thread/event` notification frames for that exact turn.
  A terminal completed/failed/aborted event ends the response.
- `GET /events` owns a filtered subscription for the response lifetime. An
  optional cursor resumes retained events. No cursor means live events only.
- SSE event data preserves the existing envelopes and Pi payloads; SSE IDs are
  opaque daemon-instance-qualified event cursors. This is the current
  single-request RPC contract, including string error codes, not a claim of
  generic JSON-RPC batch/notification support.

Capture events before submitting work and emit acceptance before buffered events.
Disconnects stop observation, never abort execution or retry a command. EOF before
a terminal event is interruption. Bound request and stream buffers; slow observers
must not block workers. Heartbeats keep otherwise quiet streams active.

Event publication is ordered even under nested emission. Replay remains bounded
and in memory; expired and prior-instance cursors fail explicitly. No durable
replay or historical turn-result store is introduced.

Client operations are `request`, `streamTurn`, and `subscribe`. HTTP uses a single
POST for finite turn streams. Socket streams use a dedicated subscription
connection, since notifications do not carry subscription IDs. CLI waits remain
the default for prompted start/send; no-wait takes precedence over streaming.

## Milestones and validation

1. Ordered events/cursors and shared finite-turn stream coordination. Test replay,
   reentrancy, immediate completion, exact-turn filtering, cancellation and bounds.
2. Shared HTTP/WS listener and HTTP/SSE endpoints. Test framing, authentication,
   origins/CORS, failure/disconnect, slow readers, replay and shutdown.
3. HTTP client, CLI integration, documentation and full smoke coverage. Test CLI
   wait/stream/no-wait and run source checks, mock smoke, actual Pi local-fixture
   smoke, bundle/executable builds and executable mock smoke.

Commit and run Keel `iterative-review` with `claude-default` after each milestone.
Fix agreed findings and request another review before proceeding. Review the
complete branch at the final milestone. No live provider-costing smoke is required.
