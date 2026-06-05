import { describe, expect, it } from "vitest";
import { EventBus } from "../src/service/event-bus.ts";

describe("EventBus", () => {
  it("filters by thread id and event type", () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe({ threadId: "a", eventTypes: ["turn.completed"] }, (event) => {
      events.push(event.eventId);
    });
    bus.emit({ type: "turn.accepted", threadId: "a", payload: {} });
    bus.emit({ type: "turn.completed", threadId: "b", payload: {} });
    bus.emit({ type: "turn.completed", threadId: "a", payload: {} });
    expect(events).toEqual(["3"]);
  });

  it("replays in-memory events after sinceEventId", () => {
    const bus = new EventBus();
    bus.emit({ type: "worker.started", payload: {} });
    bus.emit({ type: "worker.idle", payload: {} });
    expect(bus.eventsSince({ sinceEventId: "1" }).map((event) => event.type)).toEqual([
      "worker.idle",
    ]);
  });
});
