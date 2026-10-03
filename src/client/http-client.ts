import http, { type ClientRequest, type IncomingMessage } from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { DaemonError, type ErrorCode } from "../errors.ts";
import { DAEMON_EVENT_TYPES, type DaemonEvent, type EventFilter } from "../protocol/events.ts";
import type { AcceptedTurn } from "../protocol/types.ts";
import { BufferedStream } from "../protocol/stream.ts";
import {
  assertTurnMethod,
  isTerminalEvent,
  type TurnFrame,
  type TurnMethod,
} from "../protocol/turn-stream.ts";
import { validateEventFilter } from "../service/event-bus.ts";
import { readSse, type SseFrame } from "./sse-reader.ts";

import type { DaemonClientOptions } from "./options.ts";

export class HttpClient {
  private nextId = 1;
  private closed = false;
  private readonly requests = new Set<ClientRequest>();
  private readonly agent: http.Agent;
  private readonly endpoint: URL;

  constructor(private readonly options: DaemonClientOptions) {
    this.endpoint = new URL(
      options.endpoint.endsWith("/") ? options.endpoint : `${options.endpoint}/`,
    );
    if (
      !["http:", "https:"].includes(this.endpoint.protocol) ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash
    ) {
      throw new DaemonError(
        "invalidParams",
        "Expected an HTTP(S) base endpoint without credentials, query or fragment",
      );
    }
    this.agent =
      this.endpoint.protocol === "https:"
        ? new https.Agent({
            keepAlive: true,
            ...(options.tlsCa ? { ca: readFileSync(options.tlsCa) } : {}),
          })
        : new http.Agent({ keepAlive: true });
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = String(this.nextId++);
    const response = await this.open(
      "POST",
      "rpc",
      "application/json",
      JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    );
    try {
      const payload = await jsonBody(response);
      if (isRecord(payload.error)) throw remoteError(payload.error);
      if (
        response.statusCode !== 200 ||
        payload.jsonrpc !== "2.0" ||
        payload.id !== id ||
        !("result" in payload)
      )
        throw protocolError("Invalid HTTP RPC response");
      return payload.result as T;
    } finally {
      response.destroy();
    }
  }

  async streamTurn(
    method: TurnMethod,
    params: Record<string, unknown>,
  ): Promise<BufferedStream<TurnFrame>> {
    assertTurnMethod(method);
    const id = String(this.nextId++);
    const response = await this.open(
      "POST",
      "rpc",
      "text/event-stream",
      JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    );
    await assertSse(response);
    const stream = new BufferedStream<TurnFrame>(() => response.destroy());
    void (async () => {
      let accepted: AcceptedTurn | undefined;
      for await (const frame of readSse(response)) {
        const payload = parseFrame(frame);
        if (frame.event === "response") {
          if (accepted || payload.jsonrpc !== "2.0" || payload.id !== id)
            throw protocolError("Unexpected turn acknowledgement");
          if (isRecord(payload.error)) throw remoteError(payload.error);
          accepted = parseAccepted(payload.result);
          stream.push({ type: "accepted", result: accepted });
        } else {
          const event = parseEvent(frame, payload);
          if (!accepted || event.turnId !== accepted.turnId || event.threadId !== accepted.threadId)
            throw protocolError("Unexpected event outside the accepted turn");
          stream.push({ type: "event", event });
          if (isTerminalEvent(event)) {
            stream.finish();
            break;
          }
        }
        if (stream.closed) break;
      }
      if (!stream.closed)
        stream.fail(protocolError("HTTP stream ended before a terminal turn event"));
    })().catch((error) => stream.fail(error));
    return stream;
  }

  async subscribe(filter: EventFilter = {}): Promise<BufferedStream<DaemonEvent>> {
    const checked = validateEventFilter(filter);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(checked)) {
      if (value !== undefined && !(Array.isArray(value) && value.length === 0))
        query.set(key, Array.isArray(value) ? value.join(",") : value);
    }
    const response = await this.open(
      "GET",
      `events${query.size ? `?${query}` : ""}`,
      "text/event-stream",
    );
    await assertSse(response);
    const stream = new BufferedStream<DaemonEvent>(() => response.destroy());
    void (async () => {
      for await (const frame of readSse(response)) {
        stream.push(parseEvent(frame, parseFrame(frame)));
        if (stream.closed) break;
      }
      if (!stream.closed) stream.fail(protocolError("HTTP event subscription ended"));
    })().catch((error) => stream.fail(error));
    return stream;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.requests) request.destroy(protocolError("HTTP client closed"));
    this.agent.destroy();
  }

  private open(
    method: string,
    path: string,
    accept: string,
    body?: string,
  ): Promise<IncomingMessage> {
    if (this.closed) return Promise.reject(protocolError("HTTP client closed"));
    const token =
      this.options.authToken ??
      (this.options.authTokenEnv ? process.env[this.options.authTokenEnv] : undefined);
    return new Promise((resolve, reject) => {
      const request = (this.endpoint.protocol === "https:" ? https : http).request(
        new URL(path, this.endpoint),
        {
          method,
          agent: this.agent,
          headers: {
            Accept: accept,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
        resolve,
      );
      this.requests.add(request);
      request.once("close", () => this.requests.delete(request));
      request.once("error", reject);
      request.end(body);
    });
  }
}

async function assertSse(response: IncomingMessage): Promise<void> {
  if (
    response.statusCode === 200 &&
    response.headers["content-type"]?.split(";")[0] === "text/event-stream"
  )
    return;
  try {
    const payload = await jsonBody(response);
    if (isRecord(payload.error)) throw remoteError(payload.error);
    throw protocolError(`Expected SSE response, received HTTP ${response.statusCode}`);
  } finally {
    response.destroy();
  }
}
async function jsonBody(response: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw protocolError(`Expected a JSON response object, received HTTP ${response.statusCode}`);
  }
  if (!isRecord(value))
    throw protocolError(`Expected a JSON response object, received HTTP ${response.statusCode}`);
  return value;
}
function parseFrame(frame: SseFrame): Record<string, unknown> {
  const payload: unknown = JSON.parse(frame.data);
  if (!isRecord(payload)) throw protocolError("Invalid SSE JSON payload");
  if (frame.event === "stream/error") {
    if (payload.method !== "stream/error" || !isRecord(payload.params))
      throw protocolError("Invalid stream error");
    throw remoteError(payload.params);
  }
  return payload;
}
function parseEvent(frame: SseFrame, payload: Record<string, unknown>): DaemonEvent {
  const event = payload.params;
  if (
    frame.event !== "thread/event" ||
    payload.jsonrpc !== "2.0" ||
    payload.method !== "thread/event" ||
    !isRecord(event) ||
    typeof event.eventId !== "string" ||
    typeof event.timestamp !== "string" ||
    !DAEMON_EVENT_TYPES.includes(event.type as DaemonEvent["type"]) ||
    !isRecord(event.payload) ||
    (frame.id !== undefined && frame.id !== event.eventId)
  )
    throw protocolError("Invalid daemon event frame");
  return event as unknown as DaemonEvent;
}
function parseAccepted(value: unknown): AcceptedTurn {
  if (
    !isRecord(value) ||
    typeof value.threadId !== "string" ||
    !value.threadId ||
    typeof value.turnId !== "string" ||
    !value.turnId ||
    typeof value.workerId !== "string" ||
    value.status !== "accepted"
  )
    throw protocolError("Invalid turn acceptance");
  return value as unknown as AcceptedTurn;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function remoteError(value: Record<string, unknown>): DaemonError {
  return new DaemonError(
    String(value.code ?? "internal") as ErrorCode,
    String(value.message ?? "Daemon returned an error"),
    isRecord(value.data) ? value.data : undefined,
  );
}
function protocolError(message: string): DaemonError {
  return new DaemonError("streamInterrupted", message);
}
