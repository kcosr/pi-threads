import crypto from "node:crypto";
import { DaemonError } from "../errors.ts";
import { DAEMON_EVENT_TYPES, type DaemonEvent, type EventFilter } from "../protocol/events.ts";

export type EventListener = (event: DaemonEvent) => void;
interface Subscriber {
  filter: EventFilter;
  listener: EventListener;
  liveAfter: number;
  queue: DaemonEvent[];
  delivering: boolean;
}

export class EventBus {
  private readonly epoch = crypto.randomUUID();
  private nextId = 1;
  private readonly replay: DaemonEvent[] = [];
  private readonly pending: Array<{ sequence: number; event: DaemonEvent }> = [];
  private delivering = false;
  private readonly subscribers = new Map<string, Subscriber>();

  constructor(private readonly replayLimit = 1_000) {
    if (!Number.isSafeInteger(replayLimit) || replayLimit < 1) {
      throw new DaemonError("invalidParams", "Replay limit must be a positive integer");
    }
  }

  currentCursor(): string {
    return `${this.epoch}:${this.nextId - 1}`;
  }

  emit(event: Omit<DaemonEvent, "eventId" | "timestamp"> & { timestamp?: string }): DaemonEvent {
    const sequence = this.nextId++;
    const fullEvent: DaemonEvent = {
      ...event,
      eventId: `${this.epoch}:${sequence}`,
      timestamp: event.timestamp ?? new Date().toISOString(),
    };
    this.replay.push(fullEvent);
    if (this.replay.length > this.replayLimit) this.replay.shift();
    this.pending.push({ sequence, event: fullEvent });
    if (!this.delivering) {
      this.delivering = true;
      try {
        while (this.pending.length) {
          const next = this.pending.shift()!;
          for (const [id, subscriber] of [...this.subscribers]) {
            if (
              this.subscribers.has(id) &&
              next.sequence > subscriber.liveAfter &&
              matchesFilter(next.event, subscriber.filter)
            ) {
              subscriber.queue.push(next.event);
              this.deliver(id, subscriber);
            }
          }
        }
      } finally {
        this.delivering = false;
      }
    }
    return fullEvent;
  }

  subscribe(filter: EventFilter, listener: EventListener): string {
    const checked = validateEventFilter(filter);
    const queue = checked.sinceEventId === undefined ? [] : this.eventsSince(checked);
    const id = `sub_${crypto.randomUUID()}`;
    const subscriber: Subscriber = {
      filter: checked,
      listener,
      liveAfter: this.nextId - 1,
      queue,
      delivering: false,
    };
    this.subscribers.set(id, subscriber);
    this.deliver(id, subscriber);
    return id;
  }

  unsubscribe(id: string): boolean {
    return this.subscribers.delete(id);
  }

  eventsSince(filter: EventFilter): DaemonEvent[] {
    const checked = validateEventFilter(filter);
    const since = checked.sinceEventId === undefined ? 0 : this.sequence(checked.sinceEventId);
    return this.replay.filter(
      (event) =>
        Number(event.eventId.slice(event.eventId.lastIndexOf(":") + 1)) > since &&
        matchesFilter(event, checked),
    );
  }

  private sequence(cursor: string): number {
    const match =
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(0|[1-9][0-9]*)$/.exec(
        cursor,
      );
    const sequence = match ? Number(match[2]) : NaN;
    if (!match || !Number.isSafeInteger(sequence))
      throw new DaemonError("invalidParams", "Invalid event cursor");
    if (match[1] !== this.epoch)
      throw new DaemonError("eventHistoryLost", "Event cursor belongs to another daemon instance");
    if (sequence >= this.nextId)
      throw new DaemonError("invalidParams", "Event cursor is in the future");
    if (sequence < this.nextId - this.replay.length - 1)
      throw new DaemonError("eventHistoryLost", "Event cursor has expired from the replay buffer");
    return sequence;
  }

  private deliver(id: string, subscriber: Subscriber): void {
    if (subscriber.delivering) return;
    subscriber.delivering = true;
    try {
      while (this.subscribers.has(id) && subscriber.queue.length)
        subscriber.listener(subscriber.queue.shift()!);
    } catch {
      // Failed observers are detached without interrupting worker lifecycle or peers.
      this.subscribers.delete(id);
      subscriber.queue.length = 0;
    } finally {
      subscriber.delivering = false;
    }
  }
}

export function validateEventFilter(value: unknown): EventFilter {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DaemonError("invalidParams", "Event filter must be an object");
  const filter = value as EventFilter;
  for (const key of Object.keys(filter)) {
    if (!["threadId", "turnId", "sinceEventId", "eventTypes"].includes(key))
      throw new DaemonError("invalidParams", `Unknown event filter: ${key}`);
  }
  for (const field of ["threadId", "turnId", "sinceEventId"] as const) {
    if (filter[field] !== undefined && (typeof filter[field] !== "string" || !filter[field]))
      throw new DaemonError("invalidParams", `${field} must be a non-empty string`);
  }
  if (
    filter.eventTypes !== undefined &&
    (!Array.isArray(filter.eventTypes) ||
      filter.eventTypes.some((type) => !DAEMON_EVENT_TYPES.includes(type)))
  )
    throw new DaemonError("invalidParams", "Invalid eventTypes filter");
  return { ...filter, ...(filter.eventTypes ? { eventTypes: [...filter.eventTypes] } : {}) };
}

export function matchesFilter(event: DaemonEvent, filter: EventFilter): boolean {
  return (
    (!filter.threadId || event.threadId === filter.threadId) &&
    (!filter.turnId || event.turnId === filter.turnId) &&
    (!filter.eventTypes?.length || filter.eventTypes.includes(event.type))
  );
}
