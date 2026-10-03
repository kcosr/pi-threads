import { describe, expect, it, vi } from "vitest";
import { createTurnStream, type TurnSource } from "../src/protocol/turn-stream.ts";
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
    const frames = await collect(createTurnStream(f.source, "thread/send", {}));
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
    await expect(createTurnStream(f.source, "thread/send", {}).next()).rejects.toThrow(
      "admission failed",
    );
    expect(f.dispose).toHaveBeenCalledOnce();
    const g = fixture(() => accepted);
    const stream = createTurnStream(g.source, "thread/send", {});
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
        subscribe: () =>
          new Promise((resolve) => {
            subscribed = resolve;
          }),
      },
      "thread/send",
      {},
    );
    const next = stream.next();
    await stream.close();
    await expect(next).resolves.toMatchObject({ done: true });
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
    const stream = createTurnStream(f.source, "thread/send", {});
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
    await expect(createTurnStream(f.source, "thread/send", {}, 256).next()).rejects.toMatchObject({
      code: "streamOverflow",
    });
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it("bounds slow consumers and disposes on iterator return", async () => {
    const dispose = vi.fn();
    const stream = new BufferedStream<string>(dispose, 10);
    stream.push("1234");
    stream.push("5678");
    await expect(stream.next()).rejects.toMatchObject({ code: "streamOverflow" });
    expect(dispose).toHaveBeenCalledOnce();
    const f = fixture(() => accepted);
    const turns = createTurnStream(f.source, "thread/send", {});
    for await (const _frame of turns) break;
    expect(f.dispose).toHaveBeenCalledOnce();
  });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of stream) result.push(item);
  return result;
}
