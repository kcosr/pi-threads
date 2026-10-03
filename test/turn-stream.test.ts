import { describe, expect, it, vi } from "vitest";
import { createTurnStream, type TurnSource } from "../src/protocol/turn-stream.ts";
import { EventBus } from "../src/service/event-bus.ts";
import { BufferedStream } from "../src/protocol/stream.ts";
import type { DaemonEvent } from "../src/protocol/events.ts";
import type { AcceptedTurn } from "../src/protocol/types.ts";

const accepted: AcceptedTurn = {
  threadId: "thread",
  turnId: "turn",
  workerId: "worker",
  status: "accepted",
};
const event = (type: DaemonEvent["type"], turnId = "turn", threadId = "thread"): DaemonEvent => ({
  eventId: "cursor",
  timestamp: "now",
  type,
  turnId,
  threadId,
  payload: {},
});
function fixture(
  run: (send: (event: DaemonEvent) => void) => Promise<AcceptedTurn> | AcceptedTurn,
) {
  let send!: (event: DaemonEvent) => void;
  let fail!: (error: unknown) => void;
  const dispose = vi.fn();
  const source: TurnSource = {
    resolveThreadId: async (input) => input,
    subscribe: (_filter, listener, onError) => {
      send = listener;
      fail = onError;
      return dispose;
    },
    request: vi.fn(async () => run(send)),
  };
  return {
    source,
    dispose,
    send: (value: DaemonEvent) => send(value),
    fail: (error: unknown) => fail(error),
  };
}

describe("turn streams", () => {
  it("emits acceptance first and selects the exact turn even when it completes during submission", async () => {
    const f = fixture((send) => {
      send(event("turn.completed", "old"));
      send(event("turn.completed", "turn", "other"));
      send(event("message.delta"));
      send(event("turn.completed"));
      return accepted;
    });
    const frames = await collect(createTurnStream(f.source, "thread/send", { threadId: "thread" }));
    expect(frames).toEqual([
      { type: "accepted", result: accepted },
      { type: "event", event: event("message.delta") },
      { type: "event", event: event("turn.completed") },
    ]);
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    "turn.failed",
    "turn.aborted",
  ] as const)("delivers %s as a terminal event", async (type) => {
    const f = fixture((send) => {
      send(event(type));
      return accepted;
    });
    const frames = await collect(createTurnStream(f.source, "thread/start", {}));
    expect(frames.at(-1)).toEqual({ type: "event", event: event(type) });
  });

  it("cleans up failed admission and connection loss", async () => {
    const f = fixture(() => {
      throw new Error("admission failed");
    });
    await expect(
      createTurnStream(f.source, "thread/send", { threadId: "thread" }).next(),
    ).rejects.toThrow("admission failed");
    expect(f.dispose).toHaveBeenCalledOnce();
    const g = fixture(() => accepted);
    const stream = createTurnStream(g.source, "thread/send", { threadId: "thread" });
    await stream.next();
    const next = stream.next();
    g.fail(new Error("disconnected"));
    await expect(next).rejects.toThrow("disconnected");
    expect(g.dispose).toHaveBeenCalledOnce();
  });

  it("closes a late subscription without submitting work", async () => {
    let subscribed!: (dispose: () => void) => void;
    const dispose = vi.fn();
    const request = vi.fn();
    const stream = createTurnStream(
      {
        request,
        resolveThreadId: async (input) => input,
        subscribe: () =>
          new Promise((resolve) => {
            subscribed = resolve;
          }),
      },
      "thread/send",
      { threadId: "thread" },
    );
    await vi.waitFor(() => expect(subscribed).toBeTypeOf("function"));
    const next = stream.next();
    await stream.close();
    await expect(next).resolves.toMatchObject({ done: true });
    await vi.waitFor(() => expect(subscribed).toBeTypeOf("function"));
    subscribed(dispose);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(request).not.toHaveBeenCalled();
  });

  it("closes observation during admission without cancelling or yielding its late result", async () => {
    let resolve!: (value: AcceptedTurn) => void;
    const f = fixture(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const stream = createTurnStream(f.source, "thread/send", { threadId: "thread" });
    await vi.waitFor(() => expect(f.source.request).toHaveBeenCalledOnce());
    await stream.close();
    resolve(accepted);
    await expect(stream.next()).resolves.toMatchObject({ done: true });
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it("bounds events buffered before acceptance", async () => {
    const f = fixture((send) => {
      send({ ...event("message.delta"), payload: { text: "x".repeat(1024) } });
      return accepted;
    });
    await expect(
      createTurnStream(f.source, "thread/send", { threadId: "thread" }, 256).next(),
    ).rejects.toMatchObject({
      code: "streamOverflow",
    });
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it("bounds matching events after acceptance and disposes once", async () => {
    const f = fixture(() => accepted);
    const stream = createTurnStream(f.source, "thread/send", { threadId: "thread" }, 512);
    await stream.next();
    for (let i = 0; i < 10; i++) f.send(event("message.delta"));
    await expect(stream.next()).rejects.toMatchObject({ code: "streamOverflow" });
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it("resolves a session path before subscribing to the canonical thread", async () => {
    const f = fixture((send) => {
      send(event("turn.completed"));
      return accepted;
    });
    f.source.resolveThreadId = vi.fn(async () => "thread");
    const subscribe = vi.spyOn(f.source, "subscribe");
    await collect(createTurnStream(f.source, "thread/send", { threadId: "/session.jsonl" }));
    expect(subscribe.mock.calls[0]![0]).toEqual({ threadId: "thread" });
    expect(f.source.request).toHaveBeenCalledWith("thread/send", { threadId: "thread" });
  });

  it("does not count unrelated thread traffic against pending admission", async () => {
    const bus = new EventBus();
    let admit!: (value: AcceptedTurn) => void;
    const source: TurnSource = {
      resolveThreadId: async () => "thread",
      request: () =>
        new Promise((resolve) => {
          admit = resolve;
        }),
      subscribe: (filter, listener) => {
        const id = bus.subscribe(filter, listener);
        return () => {
          bus.unsubscribe(id);
        };
      },
    };
    const stream = createTurnStream(source, "thread/send", { threadId: "/session.jsonl" }, 512);
    await vi.waitFor(() => expect(admit).toBeTypeOf("function"));
    bus.emit({ type: "message.delta", threadId: "other", payload: { text: "x".repeat(1024) } });
    bus.emit({ type: "turn.completed", threadId: "thread", turnId: "turn", payload: {} });
    admit(accepted);
    expect(await collect(stream)).toHaveLength(2);
  });

  it("settles waiting consumers even when disposal throws", async () => {
    const stream = new BufferedStream<string>(() => {
      throw new Error("cleanup failed");
    });
    const next = stream.next();
    stream.finish();
    await expect(next).rejects.toThrow("cleanup failed");
    const failed = new BufferedStream<string>(() => {
      throw new Error("cleanup failed");
    });
    const waiting = failed.next();
    failed.fail(new Error("original failure"));
    await expect(waiting).rejects.toThrow("original failure");
  });

  it.each([
    null,
    undefined,
    false,
    0,
    "",
  ])("preserves falsy rejection reasons: %s", async (reason) => {
    const stream = new BufferedStream<string>();
    stream.fail(reason);
    await expect(
      stream.next().then(
        () => "unexpected success",
        (error) => error,
      ),
    ).resolves.toBe(reason);
  });

  it("bounds slow consumers and disposes on iterator return", async () => {
    const dispose = vi.fn();
    const stream = new BufferedStream<string>(dispose, 10);
    stream.push("1234");
    stream.push("5678");
    await expect(stream.next()).rejects.toMatchObject({ code: "streamOverflow" });
    expect(dispose).toHaveBeenCalledOnce();
    const f = fixture(() => accepted);
    const turns = createTurnStream(f.source, "thread/send", { threadId: "thread" });
    for await (const _frame of turns) break;
    expect(f.dispose).toHaveBeenCalledOnce();
  });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of stream) result.push(item);
  return result;
}
