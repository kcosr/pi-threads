import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonError } from "../src/errors.ts";
import { EventBus } from "../src/service/event-bus.ts";
import type { PiThreadsService } from "../src/service/pi-threads-service.ts";
import type { DaemonEvent } from "../src/protocol/events.ts";
import { MAX_STREAM_BYTES } from "../src/protocol/stream.ts";
import { startNetworkServer, MAX_REQUEST_BYTES } from "../src/transport/http.ts";
import { writeSse, DRAIN_TIMEOUT_MS } from "../src/transport/sse.ts";
import type { AuthConfig } from "../src/security/auth.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.useRealTimers();
});

async function fixture(auth: AuthConfig = {}) {
  const bus = new EventBus(3);
  const accepted = { threadId: "t", turnId: "run", workerId: "w", status: "accepted" };
  const emit = (type: DaemonEvent["type"], turnId = "run") =>
    bus.emit({ type, threadId: "t", turnId, workerId: "w", payload: { marker: type } });
  const dispatch = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "bad") throw new DaemonError("busy", "Already running");
    if (method === "thread/start" || method === "thread/send") {
      if (params.reject) throw new DaemonError("capacity", "No worker available");
      emit("turn.accepted");
      emit("message.delta", "unrelated");
      emit("message.delta");
      if (!params.hold) emit(params.fail ? "turn.failed" : "turn.completed");
      return accepted;
    }
    return { ok: true };
  });
  const unsubscribe = vi.fn((id: string) => bus.unsubscribe(id));
  const subscribe = vi.fn(bus.subscribe.bind(bus));
  const service = {
    dispatch,
    subscribe,
    unsubscribe,
    catalog: { resolveThread: async () => ({ id: "t" }) },
  } as unknown as PiThreadsService;
  let stopped = false;
  const transport = await startNetworkServer({
    bind: "127.0.0.1",
    port: 0,
    auth,
    service,
    onShutdown: async () => {
      stopped = true;
      await transport.close();
    },
  });
  cleanups.push(() => transport.close());
  const base = transport.names[0]!;
  const post = (method: string, params = {}, stream = false, extra: Record<string, string> = {}) =>
    fetch(`${base}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        ...extra,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method,
        params: { threadId: "t", ...params },
      }),
    });
  return {
    bus,
    emit,
    dispatch,
    subscribe,
    unsubscribe,
    transport,
    base,
    post,
    stopped: () => stopped,
  };
}
function frames(text: string) {
  return text
    .split("\n\n")
    .filter((frame) => frame.includes("data:"))
    .map((frame) => ({
      event: frame
        .split("\n")
        .find((line) => line.startsWith("event:"))!
        .slice(7),
      id: frame
        .split("\n")
        .find((line) => line.startsWith("id:"))
        ?.slice(4),
      data: JSON.parse(
        frame
          .split("\n")
          .find((line) => line.startsWith("data:"))!
          .slice(6),
      ),
    }));
}

describe("HTTP RPC and SSE", () => {
  it("returns ordinary RPC results/errors and shares listener with WebSocket", async () => {
    const f = await fixture();
    expect(await (await f.post("server/status")).json()).toEqual({
      jsonrpc: "2.0",
      id: "1",
      result: { ok: true },
    });
    expect(await (await f.post("bad")).json()).toMatchObject({ id: "1", error: { code: "busy" } });
    expect(f.transport.names[1]).toBe(f.base.replace("http:", "ws:"));
  });

  it("streams acceptance before early events, filters exact turn and ends after terminal", async () => {
    const f = await fixture();
    const response = await f.post("thread/send", {}, true);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const output = frames(await response.text());
    expect(output.map((frame) => frame.data.result?.status ?? frame.data.params.type)).toEqual([
      "accepted",
      "turn.accepted",
      "message.delta",
      "turn.completed",
    ]);
    expect(output[1]!.id).toBe(output[1]!.data.params.eventId);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("distinguishes admission errors from accepted turns that fail", async () => {
    const f = await fixture();
    const rejected = frames(await (await f.post("thread/send", { reject: true }, true)).text());
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.data.error.code).toBe("capacity");
    const failed = frames(await (await f.post("thread/send", { fail: true }, true)).text());
    expect(failed.at(-1)!.data.params.type).toBe("turn.failed");
    expect(f.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("cleans up disconnected observers without issuing abort", async () => {
    const f = await fixture();
    const response = await f.post("thread/send", { hold: true }, true);
    await response.body!.cancel();
    await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledOnce());
    expect(f.dispatch.mock.calls.map(([method]) => method)).toEqual(["thread/send"]);
    f.emit("turn.completed");
  });

  it("supports live filtered subscriptions and resumed retained events", async () => {
    const f = await fixture();
    const before = f.emit("worker.started");
    f.emit("message.delta");
    const response = await fetch(`${f.base}/events?threadId=t&eventTypes=message.delta`, {
      headers: { "Last-Event-ID": before.eventId },
    });
    const reader = response.body!.getReader();
    const first = frames(new TextDecoder().decode((await reader.read()).value));
    expect(first[0]!.data.params.type).toBe("message.delta");
    f.emit("turn.completed");
    f.emit("message.delta");
    const second = frames(new TextDecoder().decode((await reader.read()).value));
    expect(second).toHaveLength(1);
    expect(second[0]!.data.params.type).toBe("message.delta");
    await reader.cancel();
    await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledOnce());
    const live = await fetch(`${f.base}/events`);
    const liveReader = live.body!.getReader();
    const next = liveReader.read();
    const expected = f.emit("worker.idle");
    expect(frames(new TextDecoder().decode((await next).value))[0]!.data.params.eventId).toBe(
      expected.eventId,
    );
    await liveReader.cancel();
  });

  it("rejects expired/reset cursors and malformed filters before SSE headers", async () => {
    const f = await fixture();
    const expired = f.bus.currentCursor();
    for (let i = 0; i < 4; i++) f.emit("worker.started");
    for (const cursor of [expired, new EventBus().currentCursor()]) {
      const response = await fetch(`${f.base}/events`, { headers: { "Last-Event-ID": cursor } });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "eventHistoryLost" } });
    }
    for (const query of [
      "eventTypes=wrong",
      "threadId=",
      "threadId=a&threadId=b",
      "unknown=x",
      "sinceEventId=1",
    ]) {
      expect((await fetch(`${f.base}/events?${query}`)).status).toBe(400);
    }
  });

  it("enforces auth/origins and handles preflight without bearer credentials", async () => {
    const f = await fixture({ token: "secret", allowedOrigins: ["https://app.example"] });
    expect((await f.post("server/status")).status).toBe(401);
    expect((await f.post("server/status", {}, false, { Authorization: "Bearer bad" })).status).toBe(
      403,
    );
    expect(
      (
        await f.post("server/status", {}, false, {
          Authorization: "Bearer secret",
          Origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    const good = await f.post("server/status", {}, false, {
      Authorization: "Bearer secret",
      Origin: "https://app.example",
    });
    expect(good.status).toBe(200);
    expect(good.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const preflight = await fetch(`${f.base}/rpc`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect((await fetch(`${f.base}/events`)).status).toBe(401);
  });

  it("validates routes, methods, content types, request size and streaming methods", async () => {
    const f = await fixture();
    expect((await fetch(`${f.base}/missing`)).status).toBe(404);
    expect((await fetch(`${f.base}/rpc`)).status).toBe(405);
    expect((await fetch(`${f.base}/rpc`, { method: "POST", body: "{}" })).status).toBe(415);
    expect((await f.post("server/status", {}, true)).status).toBe(400);
    expect((await f.post("subscribe/all")).status).toBe(400);
    const headers = { "Content-Type": "application/json" };
    expect((await fetch(`${f.base}/rpc`, { method: "POST", headers, body: "[1,2]" })).status).toBe(
      400,
    );
    expect(
      (
        await fetch(`${f.base}/rpc`, {
          method: "POST",
          headers,
          body: "x".repeat(MAX_REQUEST_BYTES + 1),
        })
      ).status,
    ).toBe(413);
    expect((await f.post("server/status", {}, false, { Accept: "text/plain" })).status).toBe(406);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("honors response quality preferences and explicit exclusions", async () => {
    const f = await fixture();
    const json = await f.post("thread/send", {}, false, {
      Accept: "application/json;q=1, text/event-stream;q=0.5",
    });
    expect(json.headers.get("content-type")).toBe("application/json");
    expect((await json.json()).result.status).toBe("accepted");
    const excluded = await fetch(`${f.base}/events`, {
      headers: { Accept: "text/event-stream;q=0, */*;q=1" },
    });
    expect(excluded.status).toBe(406);
  });

  it("preserves parsed request IDs on validation failures", async () => {
    const f = await fixture();
    for (const input of [
      { method: "server/status", params: [] },
      { method: "subscribe/all", params: {} },
    ]) {
      const response = await fetch(`${f.base}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "correlate-me", ...input }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        id: "correlate-me",
        error: { code: "invalidParams" },
      });
    }
  });

  it.each(["message", "data"])("bounds oversized admission error %s", async (field) => {
    const f = await fixture();
    f.dispatch.mockRejectedValueOnce(
      new DaemonError(
        "piRpcError",
        field === "message" ? "x".repeat(MAX_STREAM_BYTES + 1) : "failed",
        field === "data" ? { text: "x".repeat(MAX_STREAM_BYTES + 1) } : undefined,
      ),
    );
    const text = await (await f.post("thread/send", {}, true)).text();
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_STREAM_BYTES);
    expect(frames(text)[0]!.data).toMatchObject({ id: "1", error: { code: "streamOverflow" } });
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("flushes shutdown acknowledgement and interrupts open streams", async () => {
    const f = await fixture();
    const stream = await f.post("thread/send", { hold: true }, true);
    const stopped = await f.post("server/shutdown");
    expect(await stopped.json()).toMatchObject({ result: { ok: true } });
    expect(frames(await stream.text()).at(-1)!.data).toMatchObject({
      method: "stream/error",
      params: { code: "streamInterrupted" },
    });
    await vi.waitFor(() => expect(f.stopped()).toBe(true));
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("rejects oversized frames and unsubscribes a subscription whose replay overflows", async () => {
    const f = await fixture();
    const cursor = f.bus.currentCursor();
    f.bus.emit({ type: "message.delta", payload: { text: "x".repeat(4 * 1024 * 1024) } });
    const response = await fetch(`${f.base}/events`, { headers: { "Last-Event-ID": cursor } });
    expect(frames(await response.text()).at(-1)!.data.params.code).toBe("streamOverflow");
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("SSE backpressure", () => {
  it("waits for drain and rejects disconnected readers", async () => {
    const response = Object.assign(new EventEmitter(), {
      write: () => false,
      destroyed: false,
      writableEnded: false,
    });
    const writing = writeSse(response as unknown as ServerResponse, "data: {}\n\n");
    response.emit("drain");
    await writing;
    expect(response.listenerCount("close")).toBe(0);
    const lost = writeSse(response as unknown as ServerResponse, "data: {}\n\n");
    response.emit("close");
    await expect(lost).rejects.toMatchObject({ code: "streamInterrupted" });
  });

  it("bounds the lifetime of a stalled reader", async () => {
    vi.useFakeTimers();
    const response = Object.assign(new EventEmitter(), {
      write: () => false,
      destroy: vi.fn(),
      destroyed: false,
      writableEnded: false,
    });
    const writing = expect(
      writeSse(response as unknown as ServerResponse, "data: {}\n\n"),
    ).rejects.toMatchObject({ code: "streamOverflow" });
    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS);
    await writing;
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(response.listenerCount("drain")).toBe(0);
  });
});
