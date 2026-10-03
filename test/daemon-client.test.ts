import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client/daemon-client.ts";
import { EventBus } from "../src/service/event-bus.ts";
import { DaemonError } from "../src/errors.ts";
import type { PiThreadsService } from "../src/service/pi-threads-service.ts";
import { startNetworkServer } from "../src/transport/http.ts";
import { startUnixSocketServer } from "../src/transport/unix.ts";
import { readSse } from "../src/client/sse-reader.ts";
import { MAX_STREAM_BYTES } from "../src/protocol/stream.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
const collect = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
};
function temp() {
  const path = mkdtempSync(join(tmpdir(), "pi-threads-client-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
async function fixture(protocol: "unix" | "ws" | "http" | "https") {
  const bus = new EventBus();
  let turn = 0;
  const unsubscribe = vi.fn((id: string) => bus.unsubscribe(id));
  const dispatch = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "thread/read") return { thread: { threadId: "thread" } };
    if (method === "bad") throw new DaemonError("busy", "Already running");
    if (method === "thread/start" || method === "thread/send") {
      const turnId = `turn-${++turn}`;
      bus.emit({
        type: "message.delta",
        threadId: "thread",
        turnId,
        payload: { text: "hello 😀" },
      });
      if (!params.hold)
        bus.emit({
          type: params.fail ? "turn.failed" : "turn.completed",
          threadId: "thread",
          turnId,
          payload: {},
        });
      return { threadId: "thread", turnId, workerId: "worker", status: "accepted" };
    }
    return { ok: true };
  });
  const service = {
    dispatch,
    subscribe: bus.subscribe.bind(bus),
    unsubscribe,
    catalog: { resolveThread: async () => ({ id: "thread" }) },
  } as unknown as PiThreadsService;
  let endpoint: string;
  let tlsCa: string | undefined;
  if (protocol === "unix") {
    const transport = await startUnixSocketServer({ path: join(temp(), "daemon.sock"), service });
    cleanups.push(() => transport.close());
    endpoint = transport.names[0]!;
  } else {
    let tls: { cert: string; key: string } | undefined;
    if (protocol === "https") {
      const dir = temp();
      const cert = join(dir, "cert.pem");
      const key = join(dir, "key.pem");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          cert,
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=IP:127.0.0.1,DNS:localhost",
        ],
        { stdio: "ignore" },
      );
      tls = { cert, key };
      tlsCa = cert;
    }
    const transport = await startNetworkServer({
      bind: "127.0.0.1",
      port: 0,
      tls,
      auth: { token: "secret" },
      service,
    });
    cleanups.push(() => transport.close());
    endpoint = transport.names[protocol === "ws" ? 1 : 0]!;
  }
  const client = new DaemonClient({ endpoint, authToken: "secret", tlsCa });
  cleanups.push(() => client.close());
  return { client, bus, dispatch, unsubscribe, endpoint, tlsCa };
}

describe.each(["unix", "ws", "http", "https"] as const)("DaemonClient over %s", (protocol) => {
  it("provides matching request and complete turn-stream semantics", async () => {
    const f = await fixture(protocol);
    expect(await f.client.request("server/status")).toEqual({ ok: true });
    await expect(f.client.request("bad")).rejects.toMatchObject({ code: "busy" });
    const frames = await collect(
      await f.client.streamTurn("thread/send", { threadId: "/session.jsonl", prompt: "hi" }),
    );
    expect(
      frames.map((frame) => (frame.type === "accepted" ? "accepted" : frame.event.type)),
    ).toEqual(["accepted", "message.delta", "turn.completed"]);
    const failed = await collect(await f.client.streamTurn("thread/start", { fail: true }));
    expect(failed.at(-1)).toMatchObject({ type: "event", event: { type: "turn.failed" } });
    await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledTimes(2));
  });

  it("owns independent overlapping subscriptions and leaves daemon work running on close", async () => {
    const f = await fixture(protocol);
    const a = await f.client.subscribe({ threadId: "thread", eventTypes: [] });
    const b = await f.client.subscribe({ threadId: "thread" });
    const value = f.bus.emit({ type: "thread.updated", threadId: "thread", payload: {} });
    expect((await a.next()).value).toEqual(value);
    expect((await b.next()).value).toEqual(value);
    await a.close();
    const next = f.bus.emit({ type: "thread.updated", threadId: "thread", payload: {} });
    expect((await b.next()).value).toEqual(next);
    await b.close();
    const stream = await f.client.streamTurn("thread/send", { threadId: "thread", hold: true });
    expect((await stream.next()).value).toMatchObject({ type: "accepted" });
    await stream.close();
    await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledTimes(3));
    expect(f.dispatch.mock.calls.some(([method]) => method.includes("abort"))).toBe(false);
    expect(await f.client.request("server/status")).toEqual({ ok: true });
  });

  it("resumes retained events and closes pending stream reads with the client", async () => {
    const f = await fixture(protocol);
    const cursor = f.bus.currentCursor();
    const value = f.bus.emit({ type: "thread.updated", threadId: "thread", payload: {} });
    const stream = await f.client.subscribe({ sinceEventId: cursor });
    expect((await stream.next()).value).toEqual(value);
    const next = expect(stream.next()).rejects.toThrow();
    await f.client.close();
    await next;
    await expect(f.client.request("server/status")).rejects.toThrow("closed");
  });
});

describe("socket cancellation during setup", () => {
  it("cancels a pending handshake under Bun without unhandled teardown errors", async () => {
    const clientModule = new URL("../src/client/daemon-client.ts", import.meta.url).href;
    await promisify(execFile)(
      "bun",
      [
        "--eval",
        `import http from "node:http";
import { once } from "node:events";
import { DaemonClient } from ${JSON.stringify(clientModule)};
const server = http.createServer();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const upgraded = once(server, "upgrade");
const client = new DaemonClient({ endpoint: "ws://127.0.0.1:" + server.address().port });
const pending = client.request("server/status").then(
  () => { throw new Error("Request unexpectedly completed"); },
  error => { if (!error.message.includes("closed")) throw error; },
);
const [, socket] = await upgraded;
socket.once("end", () => socket.destroy());
socket.resume();
const closed = once(socket, "close");
await client.close();
await pending;
await closed;
await new Promise(resolve => server.close(resolve));`,
      ],
      { timeout: 5_000 },
    );
  });

  it.each([
    "client",
    "stream",
  ])("closes a pending WebSocket handshake with %s.close()", async (owner) => {
    const sockets = new Set<Duplex>();
    let upgraded = false;
    const server = http.createServer();
    server.on("upgrade", (_request, socket) => {
      upgraded = true;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("end", () => socket.destroy());
      socket.resume();
      // Deliberately withhold the handshake response.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const client = new DaemonClient({
      endpoint: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    });
    cleanups.push(() => client.close());
    const stream = owner === "stream" ? await client.streamTurn("thread/start", {}) : undefined;
    const pending = stream
      ? expect(stream.next()).resolves.toMatchObject({ done: true })
      : expect(client.request("server/status")).rejects.toThrow("closed");
    await vi.waitFor(() => expect(upgraded).toBe(true));
    if (stream) await stream.close();
    else await client.close();
    await pending;
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });

  it("closes a turn stream while its subscription acknowledgement is pending", async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const requests: string[] = [];
    wss.on("connection", (socket) => {
      socket.on("message", (message) => requests.push(JSON.parse(message.toString()).method));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    cleanups.push(() => {
      for (const socket of wss.clients) socket.terminate();
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    const client = new DaemonClient({
      endpoint: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    });
    cleanups.push(() => client.close());
    const stream = await client.streamTurn("thread/start", {});
    await vi.waitFor(() => expect(requests).toEqual(["subscribe/all"]));
    await stream.close();
    await expect(stream.next()).resolves.toMatchObject({ done: true });
    await vi.waitFor(() => expect(wss.clients.size).toBe(0));
    expect(requests).toEqual(["subscribe/all"]);
  });
});

describe("HTTP client failure handling", () => {
  it.each([
    "request",
    "streamTurn",
    "subscribe",
  ] as const)("reports the HTTP status for non-JSON proxy errors during %s", async (operation) => {
    let requests = 0;
    const server = http.createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(502, { "Content-Type": "text/html" });
      response.end("<html>Bad Gateway</html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const client = new DaemonClient({
      endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    });
    cleanups.push(() => client.close());
    const result =
      operation === "subscribe" ? client.subscribe() : client[operation]("thread/start", {});
    await expect(result).rejects.toMatchObject({
      code: "streamInterrupted",
      message: "Expected a JSON response object, received HTTP 502",
    });
    expect(requests).toBe(1);
  });

  it("rejects untrusted HTTPS and missing bearer credentials", async () => {
    const f = await fixture("https");
    const untrusted = new DaemonClient({ endpoint: f.endpoint, authToken: "secret" });
    cleanups.push(() => untrusted.close());
    await expect(untrusted.request("server/status")).rejects.toThrow();
    const unauthenticated = new DaemonClient({ endpoint: f.endpoint, tlsCa: f.tlsCa });
    cleanups.push(() => unauthenticated.close());
    await expect(unauthenticated.request("server/status")).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(readFileSync(f.tlsCa!, "utf8")).toContain("BEGIN CERTIFICATE");
  });

  it("reports premature EOF without resubmitting a POST", async () => {
    let requests = 0;
    const server = http.createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        'event: response\ndata: {"jsonrpc":"2.0","id":"1","result":{"threadId":"t","turnId":"r","workerId":"w","status":"accepted"}}\n\n',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const client = new DaemonClient({
      endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    });
    cleanups.push(() => client.close());
    await expect(collect(await client.streamTurn("thread/start", {}))).rejects.toMatchObject({
      code: "streamInterrupted",
    });
    expect(requests).toBe(1);
  });
});

describe("SSE decoding", () => {
  it("handles split UTF-8, CRLF, multiple data lines and heartbeat comments", async () => {
    const data = Buffer.from(
      ': heartbeat\r\n\r\nid: cursor\r\nevent: thread/event\r\ndata: {"text":\r\ndata: "😀"}\r\n\r\n',
    );
    async function* bytes() {
      for (const byte of data) yield Uint8Array.of(byte);
    }
    const parsed = await collect(readSse(bytes()));
    expect(parsed).toEqual([{ event: "thread/event", id: "cursor", data: '{"text":\n"😀"}' }]);
  });
  it("rejects oversized unterminated frames", async () => {
    async function* chunks() {
      yield Buffer.from(`data: ${"x".repeat(MAX_STREAM_BYTES)}`);
    }
    await expect(collect(readSse(chunks()))).rejects.toMatchObject({ code: "streamOverflow" });
  });
});
