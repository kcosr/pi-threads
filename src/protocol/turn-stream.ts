import { DaemonError } from "../errors.ts";
import { isTerminalEventType, type DaemonEvent, type EventFilter } from "./events.ts";
import type { AcceptedTurn } from "./types.ts";
import { BufferedStream, MAX_STREAM_BYTES } from "./stream.ts";

export type TurnMethod = "thread/start" | "thread/send";
export type TurnFrame =
  | { type: "accepted"; result: AcceptedTurn }
  | { type: "event"; event: DaemonEvent };
export interface TurnSource {
  resolveThreadId(input: string): Promise<string>;
  request(method: TurnMethod, params: Record<string, unknown>): Promise<AcceptedTurn>;
  subscribe(
    filter: EventFilter,
    listener: (event: DaemonEvent) => void,
    onError: (error: unknown) => void,
  ): (() => void) | Promise<() => void>;
}

export function isTerminalEvent(event: DaemonEvent): boolean {
  return isTerminalEventType(event.type);
}

export function assertTurnMethod(method: string): asserts method is TurnMethod {
  if (method !== "thread/start" && method !== "thread/send") {
    throw new DaemonError(
      "invalidParams",
      "Finite streaming supports thread/start and thread/send only",
    );
  }
}

/** Subscribe before admission, then expose acceptance and only the accepted turn's events. */
export function createTurnStream(
  source: TurnSource,
  method: TurnMethod,
  params: Record<string, unknown>,
  limit = MAX_STREAM_BYTES,
): BufferedStream<TurnFrame> {
  assertTurnMethod(method);
  let dispose: (() => void) | undefined;
  let accepted: AcceptedTurn | undefined;
  let pending: DaemonEvent[] = [];
  let pendingBytes = 0;
  const stream = new BufferedStream<TurnFrame>(() => {
    pending = [];
    dispose?.();
  }, limit);
  const deliver = (event: DaemonEvent) => {
    if (stream.closed) return;
    if (!accepted) {
      pendingBytes += Buffer.byteLength(JSON.stringify(event));
      if (pendingBytes > limit)
        stream.fail(
          new DaemonError("streamOverflow", "Pre-acceptance event buffer exceeded its byte limit"),
        );
      else pending.push(event);
      return;
    }
    if (event.turnId !== accepted.turnId || event.threadId !== accepted.threadId) return;
    stream.push({ type: "event", event });
    if (isTerminalEvent(event)) stream.finish();
  };
  void (async () => {
    let input = params;
    const filter: EventFilter = {};
    if (method === "thread/send") {
      if (typeof params.threadId !== "string" || !params.threadId) {
        throw new DaemonError("invalidParams", "threadId is required");
      }
      filter.threadId = await source.resolveThreadId(params.threadId);
      input = { ...params, threadId: filter.threadId };
    }
    if (stream.closed) return;
    dispose = await source.subscribe(filter, deliver, (error) => stream.fail(error));
    if (stream.closed) {
      dispose();
      return;
    }
    accepted = await source.request(method, input);
    if (stream.closed) return;
    stream.push({ type: "accepted", result: accepted });
    const buffered = pending;
    pending = [];
    for (const event of buffered) deliver(event);
  })().catch((error) => stream.fail(error));
  return stream;
}
