import { DaemonClient } from "../src/client/daemon-client.ts";
import { startNetworkServer } from "../src/transport/http.ts";
import type { RunningTransport } from "../src/transport/unix.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config.ts";
import type { DaemonEvent } from "../src/protocol/events.ts";
import { PiThreadsService } from "../src/service/pi-threads-service.ts";

// Run the actual pinned Pi CLI against a loopback fixture, with isolated settings,
// extensions and sessions. No provider credentials or paid model calls are used.
const root = mkdtempSync(join(tmpdir(), "pi-threads-pi1-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");
mkdirSync(join(agentDir, "extensions"), { recursive: true });
mkdirSync(cwd);
let requestCount = 0;
let slowRequest: (() => void) | undefined;
const server = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    requestCount++;
    const input = JSON.parse(body);
    const prompt = JSON.stringify(
      input.messages.filter((message: { role: string }) => message.role === "user").at(-1),
    );
    if (prompt.includes("smoke-failure")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "fixture failure", type: "invalid_request_error" } }),
      );
      return;
    }
    const send = () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = { id: "smoke", object: "chat.completion.chunk", created: 1, model: "fixture" };
      response.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "pi smoke response" }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    };
    if (prompt.includes("smoke-slow")) {
      slowRequest?.();
      const timer = setTimeout(send, 5_000);
      response.on("close", () => clearTimeout(timer));
    } else send();
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        apiKey: "local-fixture",
        models: [{ id: "fixture", contextWindow: 16384, maxTokens: 1024 }],
      },
    },
  }),
);
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "fixture",
    defaultThinkingLevel: "off",
    extensions: ["-builtin:mcp", "-builtin:llama.cpp", "-builtin:codemode", "-builtin:tool-search"],
    retry: { enabled: false },
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 },
  }),
);
writeFileSync(
  join(agentDir, "extensions", "handled.js"),
  `export default function(pi) {
  pi.registerCommand("smoke-handled", { handler: async () => {} });
  pi.on("input", event => event.text === "smoke-consumed" ? { action: "handled" } : undefined);
}`,
);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_THREADS_PI_BIN = resolve("node_modules/.bin/pi");
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, "sessions");
const config = defaultConfig();
config.defaults = { model: "fixture/fixture", thinking: "off" };
config.daemon.worker.maxWorkers = 1;
config.daemon.worker.reuseAcrossThreads = false;
const service = new PiThreadsService(config);
let network: RunningTransport | undefined;
let httpClient: DaemonClient | undefined;
const events: DaemonEvent[] = [];
service.subscribe({}, (event) => events.push(event));

try {
  await service.start();
  network = await startNetworkServer({ bind: "127.0.0.1", port: 0, auth: {}, service });
  httpClient = new DaemonClient({ endpoint: network.names[0]! });
  const blank = await service.threadStart({ cwd, name: "retained blank" });
  assert.equal(
    ((await service.threadStatus({ threadId: blank.threadId })) as { status: string }).status,
    "idle",
  );
  const handled = await service.threadSend({ threadId: blank.threadId, prompt: "/smoke-handled" });
  assert.equal((await terminal(handled.turnId)).type, "turn.completed");
  assert.equal(requestCount, 0, "handled prompts must not call a model");
  await service.threadSettingsRead({ threadId: blank.threadId });
  assert.equal(service.catalog.isPersisted(blank.threadId), false);
  await assert.rejects(service.threadStart({ cwd }), { code: "capacity" });
  const retained = await service.threadSettingsRead({ threadId: blank.threadId });
  assert.equal(retained.settings.sessionId, blank.threadId);
  assert.equal(retained.settings.sessionName, "retained blank");

  const sent = await service.threadSend({ threadId: blank.threadId, prompt: "hello" });
  assert.equal((await terminal(sent.turnId)).type, "turn.completed");
  const messages = await service.threadMessages({ threadId: blank.threadId });
  assert(JSON.stringify(messages).includes("pi smoke response"));
  const session = await service.catalog.resolveThread(blank.threadId);
  assert.equal(JSON.parse(readFileSync(session.path, "utf8").split("\n")[0]!).version, 3);
  const completed = events.find(
    (event) => event.turnId === sent.turnId && event.type === "turn.completed",
  );
  assert.equal((completed?.payload.piEvent as { type: string }).type, "agent_settled");

  await service.threadSettingsUpdate({ threadId: blank.threadId, thinking: "high" });
  const afterSettings = await service.threadSend({
    threadId: blank.threadId,
    prompt: "after settings",
  });
  assert.equal((await terminal(afterSettings.turnId)).type, "turn.completed");
  const httpFrames = [];
  for await (const frame of await httpClient.streamTurn("thread/send", {
    threadId: blank.threadId,
    prompt: "hello over HTTP",
  }))
    httpFrames.push(frame);
  assert.equal(httpFrames[0]?.type, "accepted");
  assert(
    httpFrames.some((frame) => frame.type === "event" && frame.event.type === "message.delta"),
  );
  assert(JSON.stringify(httpFrames).includes("pi smoke response"));
  const httpTerminal = httpFrames.at(-1);
  assert(httpTerminal?.type === "event" && httpTerminal.event.type === "turn.completed");
  const handledFrames = [];
  for await (const frame of await httpClient.streamTurn("thread/send", {
    threadId: blank.threadId,
    prompt: "/smoke-handled",
  }))
    handledFrames.push(frame);
  const handledTerminal = handledFrames.at(-1);
  assert(handledTerminal?.type === "event" && handledTerminal.event.type === "turn.completed");

  const bash = await service.threadBashRun({ threadId: blank.threadId, command: "printf smoke" });
  assert.equal((bash.result as { output: string }).output, "smoke");
  const afterBash = await service.threadSend({ threadId: blank.threadId, prompt: "after bash" });
  assert.equal((await terminal(afterBash.turnId)).type, "turn.completed");

  const compactionEventOffset = events.length;
  await service.threadCompact({ threadId: blank.threadId });
  assert.deepEqual(
    events
      .slice(compactionEventOffset)
      .filter((event) => event.type.startsWith("compaction."))
      .map((event) => [event.type, event.payload.reason]),
    [
      ["compaction.started", "manual"],
      ["compaction.completed", "manual"],
    ],
  );
  const afterCompact = await service.threadSend({
    threadId: blank.threadId,
    prompt: "after compact",
  });
  assert.equal((await terminal(afterCompact.turnId)).type, "turn.completed");

  const slowStarted = new Promise<void>((done) => {
    slowRequest = done;
  });
  const slow = await service.threadSend({ threadId: blank.threadId, prompt: "smoke-slow" });
  await withTimeout(slowStarted, "local slow request");
  await assert.rejects(service.threadStart({ cwd }), { code: "capacity" });
  const consumed = await service.threadFollowUp({
    threadId: blank.threadId,
    prompt: "smoke-consumed",
  });
  assert.equal(consumed.status, "handled");
  await service.threadAbort({ threadId: blank.threadId });
  assert.equal((await terminal(slow.turnId)).type, "turn.aborted");
  assert.equal(
    events.filter((event) => event.turnId === slow.turnId && isTerminal(event)).length,
    1,
  );

  const failed = await service.threadSend({ threadId: blank.threadId, prompt: "smoke-failure" });
  assert.equal((await terminal(failed.turnId)).type, "turn.failed");

  const crashingStarted = new Promise<void>((done) => {
    slowRequest = done;
  });
  const crashing = await service.threadSend({
    threadId: blank.threadId,
    prompt: "smoke-slow crash",
  });
  await withTimeout(crashingStarted, "worker crash request");
  const crashedPid = service.workers.findByThread(blank.threadId)?.pid;
  assert(crashedPid);
  process.kill(crashedPid, "SIGKILL");
  assert.equal((await terminal(crashing.turnId)).type, "turn.failed");
  const recovered = await service.threadSend({ threadId: blank.threadId, prompt: "after crash" });
  assert.equal((await terminal(recovered.turnId)).type, "turn.completed");
  assert.equal(
    ((await service.threadStatus({ threadId: blank.threadId })) as { status: string }).status,
    "idle",
  );
  assert(service.workers.list().every((worker) => worker.version === "1.0.2"));

  // One-slot pressure must replace idle processes, preserve transcripts, and
  // launch resumed threads in their original directory.
  await service.threadSettingsRead({ threadId: blank.threadId });
  const secondCwd = join(root, "second-work");
  mkdirSync(secondCwd);
  const second = await service.threadStart({ cwd: secondCwd, prompt: "second workspace" });
  assert.notEqual(second.workerId, recovered.workerId);
  assert.equal((await terminal(second.turnId)).type, "turn.completed");
  await service.threadSettingsRead({ threadId: second.threadId });
  assert.equal(service.workers.list().length, 1);
  assert.equal(service.workers.list()[0]!.cwd, secondCwd);
  const resumed = await service.threadSend({ threadId: blank.threadId, prompt: "after eviction" });
  assert.notEqual(resumed.workerId, recovered.workerId);
  assert.notEqual(resumed.workerId, second.workerId);
  assert.equal((await terminal(resumed.turnId)).type, "turn.completed");
  await service.threadSettingsRead({ threadId: blank.threadId });
  assert.equal(service.workers.list()[0]!.cwd, cwd);
  const resumedBash = await service.threadBashRun({ threadId: blank.threadId, command: "pwd" });
  assert.equal((resumedBash.result as { output: string }).output.trim(), cwd);
  assert(
    JSON.stringify(await service.threadMessages({ threadId: blank.threadId })).includes(
      "after crash",
    ),
  );
  const sameThread = await service.threadSend({ threadId: blank.threadId, prompt: "same worker" });
  assert.equal(sameThread.workerId, resumed.workerId);
  assert.equal((await terminal(sameThread.turnId)).type, "turn.completed");

  // Default cross-thread reuse must protect an unsaved session too.
  const reuseConfig = defaultConfig();
  reuseConfig.defaults = config.defaults;
  reuseConfig.daemon.worker.maxWorkers = 1;
  const reuseService = new PiThreadsService(reuseConfig);
  try {
    await reuseService.start();
    const unsaved = await reuseService.threadStart({ cwd, name: "unsaved reuse" });
    await reuseService.threadSettingsRead({ threadId: unsaved.threadId });
    assert.equal(reuseService.catalog.isPersisted(unsaved.threadId), false);
    await assert.rejects(reuseService.threadStart({ cwd }), { code: "capacity" });
    const state = await reuseService.threadSettingsRead({ threadId: unsaved.threadId });
    assert.equal(state.settings.sessionId, unsaved.threadId);
    assert.equal(state.settings.sessionName, "unsaved reuse");
  } finally {
    await reuseService.shutdown();
  }
  console.log(
    "Pi 1.0 smoke passed (real RPC, eviction/resume, local model fixture, no provider calls)",
  );
} finally {
  await httpClient?.close();
  await network?.close();
  await service.shutdown();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
}

function isTerminal(event: DaemonEvent): boolean {
  return ["turn.completed", "turn.failed", "turn.aborted"].includes(event.type);
}

async function terminal(turnId: string): Promise<DaemonEvent> {
  const found = events.find((event) => event.turnId === turnId && isTerminal(event));
  if (found) return found;
  let subscription: string | undefined;
  try {
    return await withTimeout(
      new Promise<DaemonEvent>((done) => {
        subscription = service.subscribe({ turnId }, (event) => {
          if (isTerminal(event)) done(event);
        });
      }),
      `terminal event for ${turnId}`,
    );
  } finally {
    if (subscription) service.unsubscribe(subscription);
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
