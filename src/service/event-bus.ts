import crypto from "node:crypto";
import type { DaemonEvent, DaemonEventType, EventFilter } from "../protocol/events.ts";

export type EventListener = (event: DaemonEvent) => void;

export class EventBus {
  private nextId = 1;
  private readonly replay: DaemonEvent[] = [];
  private readonly subscribers = new Map<
    string,
    { filter: EventFilter; listener: EventListener }
  >();

  constructor(private readonly replayLimit = 1_000) {}

  emit(event: Omit<DaemonEvent, "eventId" | "timestamp"> & { timestamp?: string }): DaemonEvent {
    const fullEvent: DaemonEvent = {
      ...event,
      eventId: String(this.nextId++),
      timestamp: event.timestamp ?? new Date().toISOString(),
    };
    this.replay.push(fullEvent);
    if (this.replay.length > this.replayLimit) {
      this.replay.shift();
    }
    for (const subscriber of this.subscribers.values()) {
      if (matchesFilter(fullEvent, subscriber.filter)) {
        subscriber.listener(fullEvent);
      }
    }
    return fullEvent;
  }

  subscribe(filter: EventFilter, listener: EventListener): string {
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    this.subscribers.set(subscriptionId, { filter, listener });
    for (const event of this.eventsSince(filter)) {
      listener(event);
    }
    return subscriptionId;
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.subscribers.delete(subscriptionId);
  }

  eventsSince(filter: EventFilter): DaemonEvent[] {
    const since = filter.sinceEventId ? Number(filter.sinceEventId) : 0;
    return this.replay.filter(
      (event) => Number(event.eventId) > since && matchesFilter(event, filter),
    );
  }
}

export function matchesFilter(event: DaemonEvent, filter: EventFilter): boolean {
  if (filter.threadId && event.threadId !== filter.threadId) {
    return false;
  }
  if (filter.turnId && event.turnId !== filter.turnId) {
    return false;
  }
  if (filter.eventTypes?.length && !filter.eventTypes.includes(event.type as DaemonEventType)) {
    return false;
  }
  return true;
}
