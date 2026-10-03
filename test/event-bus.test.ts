import { describe, expect, it } from "vitest";
import { EventBus } from "../src/service/event-bus.ts";
import type { DaemonEvent, EventFilter } from "../src/protocol/events.ts";

const emit = (bus: EventBus, type: DaemonEvent["type"] = "worker.started") =>
  bus.emit({ type, payload: {} });

describe("EventBus", () => {
  it("defaults to live-only subscriptions while snapshot inspection retains history", () => {
    const bus = new EventBus();
    emit(bus);
    const seen: DaemonEvent[] = [];
    bus.subscribe({}, (event) => seen.push(event));
    const next = emit(bus, "worker.idle");
    expect(seen).toEqual([next]);
    expect(bus.eventsSince({})).toHaveLength(2);
  });

  it("filters threads and types and snapshots mutable filters", () => {
    const bus = new EventBus();
    const filter: EventFilter = { threadId: "a", eventTypes: ["turn.completed"] };
    const seen: DaemonEvent[] = [];
    bus.subscribe(filter, (event) => seen.push(event));
    filter.threadId = "b";
    filter.eventTypes!.push("turn.started");
    bus.emit({ type: "turn.started", threadId: "a", payload: {} });
    bus.emit({ type: "turn.completed", threadId: "b", payload: {} });
    const expected = bus.emit({ type: "turn.completed", threadId: "a", payload: {} });
    expect(seen).toEqual([expected]);
  });

  it("delivers nested emissions in event order to every observer", () => {
    const bus = new EventBus();
    bus.subscribe({}, (event) => {
      if (event.type === "turn.completed") emit(bus, "worker.idle");
    });
    const seen: string[] = [];
    bus.subscribe({}, (event) => seen.push(event.type));
    emit(bus, "turn.completed");
    expect(seen).toEqual(["turn.completed", "worker.idle"]);
  });

  it("orders live events emitted during replay after all retained events", () => {
    const bus = new EventBus();
    const cursor = bus.currentCursor();
    emit(bus);
    emit(bus, "worker.idle");
    const seen: string[] = [];
    bus.subscribe({ sinceEventId: cursor }, (event) => {
      seen.push(event.type);
      if (event.type === "worker.started") emit(bus, "worker.crashed");
    });
    expect(seen).toEqual(["worker.started", "worker.idle", "worker.crashed"]);
  });

  it("does not deliver replayed queued events twice when subscribing during delivery", () => {
    const bus = new EventBus();
    const cursor = bus.currentCursor();
    const seen: string[] = [];
    bus.subscribe({}, (event) => {
      if (event.type !== "worker.started") return;
      emit(bus, "worker.idle");
      bus.subscribe({ sinceEventId: cursor }, (next) => seen.push(next.type));
    });
    emit(bus);
    emit(bus, "worker.crashed");
    expect(seen).toEqual(["worker.started", "worker.idle", "worker.crashed"]);
  });

  it("isolates failed listeners and honors unsubscription during delivery", () => {
    const bus = new EventBus();
    let calls = 0;
    bus.subscribe({}, () => {
      calls++;
      throw new Error("bad observer");
    });
    let removed = "";
    bus.subscribe({}, () => bus.unsubscribe(removed));
    removed = bus.subscribe({}, () => {
      throw new Error("unsubscribed callback called");
    });
    const seen: string[] = [];
    bus.subscribe({}, (event) => seen.push(event.type));
    emit(bus);
    emit(bus);
    expect(calls).toBe(1);
    expect(seen).toHaveLength(2);
  });

  it("resumes at the retention boundary and rejects expired/reset/future cursors", () => {
    const bus = new EventBus(2);
    const empty = bus.currentCursor();
    const first = emit(bus);
    const second = emit(bus);
    const third = emit(bus);
    expect(bus.eventsSince({ sinceEventId: first.eventId })).toEqual([second, third]);
    expect(() => bus.eventsSince({ sinceEventId: empty })).toThrow(
      expect.objectContaining({ code: "eventHistoryLost" }),
    );
    expect(() => bus.subscribe({ sinceEventId: new EventBus().currentCursor() }, () => {})).toThrow(
      expect.objectContaining({ code: "eventHistoryLost" }),
    );
    const future = first.eventId.replace(/:\d+$/, ":99");
    expect(() => bus.eventsSince({ sinceEventId: future })).toThrow(
      expect.objectContaining({ code: "invalidParams" }),
    );
    expect(bus.eventsSince({ sinceEventId: bus.currentCursor() })).toEqual([]);
  });

  it.each(["1", "", "wrong:1", "abc", null, 42])("rejects invalid cursors: %s", (cursor) => {
    expect(() => new EventBus().subscribe({ sinceEventId: cursor } as any, () => {})).toThrow();
  });

  it.each([
    { threadId: 1 },
    { eventTypes: "turn.completed" },
    { eventTypes: ["wrong"] },
    { wrong: true },
    [],
  ])("rejects malformed filters", (filter) => {
    expect(() => new EventBus().subscribe(filter as any, () => {})).toThrow();
  });
});
