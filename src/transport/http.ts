import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { DaemonError, toDaemonError } from "../errors.ts";
import {
  failure,
  normalizeParams,
  parseJsonRpcLine,
  success,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../protocol/json-rpc.ts";
import type { DaemonEvent } from "../protocol/events.ts";
import type { AcceptedTurn } from "../protocol/types.ts";
import { BufferedStream } from "../protocol/stream.ts";
import { assertTurnMethod, createTurnStream } from "../protocol/turn-stream.ts";
import {
  assertAuthConfiguredForBind,
  assertBearerToken,
  assertOriginAllowed,
  type AuthConfig,
} from "../security/auth.ts";
import { assertTlsAllowedForBind, loadTlsOptions, type TlsConfig } from "../security/tls.ts";
import { validateEventFilter } from "../service/event-bus.ts";
import type { PiThreadsService } from "../service/pi-threads-service.ts";
import type { RunningTransport } from "./unix.ts";
import { attachWebSocketServer } from "./websocket.ts";
import { beginSse, encodeSse, writeSse } from "./sse.ts";

export const MAX_REQUEST_BYTES = 1024 * 1024;
interface NetworkOptions {
  bind: string;
  port: number;
  tls?: TlsConfig;
  auth: AuthConfig;
  service: PiThreadsService;
  onShutdown?: () => void | Promise<void>;
}

export async function startNetworkServer(options: NetworkOptions): Promise<RunningTransport> {
  assertTlsAllowedForBind(options.bind, options.tls);
  assertAuthConfiguredForBind(options.bind, options.auth);
  const tls = loadTlsOptions(options.tls);
  const sockets = new Set<Socket>();
  const responses = new Set<ServerResponse>();
  let stopping = false;
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    response.on("error", () => response.destroy());
    responses.add(response);
    response.once("close", () => responses.delete(response));
    if (stopping) {
      sendError(response, 503, new DaemonError("streamInterrupted", "Daemon is stopping"));
      return;
    }
    void handleRequest(request, response, options).catch((error) => {
      if (response.headersSent) {
        sendStreamError(response, error);
      } else
        sendError(
          response,
          error instanceof HttpError ? error.status : 500,
          error,
          error instanceof HttpError ? error.requestId : null,
        );
    });
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const wss = attachWebSocketServer(server, options);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      wss.once("error", reject);
      server.listen(options.port, options.bind, () => {
        server.off("error", reject);
        wss.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    wss.close();
    throw error;
  }
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : options.port;
  const host = options.bind.includes(":") ? `[${options.bind}]` : options.bind;
  let closing: Promise<void> | undefined;
  return {
    names: [
      `${tls ? "https" : "http"}://${host}:${port}`,
      `${tls ? "wss" : "ws"}://${host}:${port}`,
    ],
    close: () => {
      closing ??= (async () => {
        stopping = true;
        const timer = setTimeout(() => {
          for (const socket of wss.clients) socket.terminate();
          for (const socket of sockets) socket.destroy();
        }, 1_000);
        const websocketClosed = new Promise<void>((done) => wss.close(() => done()));
        const httpClosed = new Promise<void>((done) => server.close(() => done()));
        for (const response of responses) {
          if (response.writableEnded) continue;
          if (response.headersSent)
            sendStreamError(response, new DaemonError("streamInterrupted", "Daemon is stopping"));
          else sendError(response, 503, new DaemonError("streamInterrupted", "Daemon is stopping"));
        }
        for (const socket of wss.clients) socket.close(1001, "Daemon stopping");
        await Promise.all([websocketClosed, httpClosed]);
        clearTimeout(timer);
      })();
      return closing;
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: NetworkOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://daemon.local");
  try {
    assertOriginAllowed(options.auth.allowedOrigins, request.headers.origin);
  } catch (error) {
    throw new HttpError(403, toDaemonError(error));
  }
  if (request.headers.origin) {
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
    response.setHeader("Vary", "Origin");
  }
  if (url.pathname !== "/rpc" && url.pathname !== "/events")
    throw new HttpError(404, new DaemonError("notFound", "Unknown HTTP route"));
  const method = url.pathname === "/rpc" ? "POST" : "GET";
  if (request.method === "OPTIONS") {
    if (request.headers["access-control-request-method"] !== method)
      throw new HttpError(405, new DaemonError("invalidParams", "Unsupported preflight method"));
    const headers = String(request.headers["access-control-request-headers"] ?? "")
      .toLowerCase()
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    if (
      headers.some((h) => !["authorization", "content-type", "accept", "last-event-id"].includes(h))
    )
      throw new HttpError(403, new DaemonError("forbidden", "Unsupported preflight header"));
    response.writeHead(204, {
      "Access-Control-Allow-Methods": method,
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Last-Event-ID",
    });
    response.end();
    return;
  }
  try {
    assertBearerToken(options.auth, request.headers.authorization);
  } catch (error) {
    const daemonError = toDaemonError(error);
    throw new HttpError(daemonError.code === "unauthorized" ? 401 : 403, daemonError);
  }
  if (request.method !== method) {
    response.setHeader("Allow", `${method}, OPTIONS`);
    throw new HttpError(405, new DaemonError("invalidParams", "Unsupported HTTP method"));
  }
  if (method === "GET") {
    if (!accepts(request, "text/event-stream"))
      throw new HttpError(
        406,
        new DaemonError("invalidParams", "Accept text/event-stream for subscriptions"),
      );
    await events(request, response, url, options.service);
    return;
  }
  if (url.search)
    throw new HttpError(
      400,
      new DaemonError("invalidParams", "RPC endpoint does not accept query parameters"),
    );
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new HttpError(
      415,
      new DaemonError("invalidParams", "Content-Type must be application/json"),
    );
  const jsonQuality = acceptQuality(request, "application/json");
  const eventQuality = acceptQuality(request, "text/event-stream");
  const streaming =
    eventQuality > 0 &&
    (eventQuality > jsonQuality ||
      (eventQuality === jsonQuality &&
        (request.headers.accept ?? "").toLowerCase().includes("text/event-stream")));
  if (!streaming && !accepts(request, "application/json"))
    throw new HttpError(406, new DaemonError("invalidParams", "Unsupported response format"));
  let rpc: JsonRpcRequest | undefined;
  let params: Record<string, unknown>;
  try {
    rpc = parseJsonRpcLine(await readBody(request));
    params = normalizeParams(rpc.params);
    if (rpc.method.startsWith("subscribe/") || rpc.method.startsWith("unsubscribe/"))
      throw new DaemonError("invalidParams", "Use GET /events to own an HTTP subscription");
    if (streaming) assertTurnMethod(rpc.method);
  } catch (error) {
    throw error instanceof HttpError ? error : new HttpError(400, toDaemonError(error), rpc?.id);
  }
  if (response.destroyed || response.writableEnded) return;
  if (streaming) {
    assertTurnMethod(rpc.method);
    const stream = createTurnStream(
      {
        resolveThreadId: async (input) => (await options.service.catalog.resolveThread(input)).id,
        request: (method, input) =>
          options.service.dispatch(method, input) as Promise<AcceptedTurn>,
        subscribe: (filter, listener) => {
          const id = options.service.subscribe(filter, listener);
          return () => {
            options.service.unsubscribe(id);
          };
        },
      },
      rpc.method,
      params,
    );
    const close = () => {
      void stream.close();
    };
    response.once("close", close);
    const stopHeartbeat = beginSse(response);
    let accepted = false;
    try {
      for await (const frame of stream) {
        if (frame.type === "accepted") {
          await writeSse(response, encodeSse("response", success(rpc.id, frame.result)));
          accepted = true;
        } else
          await writeSse(
            response,
            encodeSse(
              "thread/event",
              { jsonrpc: "2.0", method: "thread/event", params: frame.event },
              frame.event.eventId,
            ),
          );
      }
      response.end();
    } catch (error) {
      if (!accepted && !response.destroyed && !response.writableEnded) {
        await finishSseError(response, "response", error, rpc.id);
      } else sendStreamError(response, error);
    } finally {
      stopHeartbeat();
      response.off("close", close);
      await stream.close();
    }
    return;
  }
  let result: JsonRpcResponse;
  try {
    result = success(rpc.id, await options.service.dispatch(rpc.method, params));
  } catch (error) {
    result = failure(rpc.id, error);
  }
  const shutdown = rpc.method === "server/shutdown" && "result" in result;
  if (response.destroyed || response.writableEnded) {
    if (shutdown) await options.onShutdown?.();
    return;
  }
  if (shutdown) {
    let notified = false;
    const stop = () => {
      if (!notified) {
        notified = true;
        void options.onShutdown?.();
      }
    };
    response.once("finish", stop);
    response.once("close", stop);
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(result));
}

async function events(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: PiThreadsService,
): Promise<void> {
  const raw: Record<string, unknown> = {};
  for (const key of url.searchParams.keys()) {
    if (url.searchParams.getAll(key).length !== 1)
      throw new HttpError(400, new DaemonError("invalidParams", "Duplicate event filter"));
    raw[key] =
      key === "eventTypes" ? url.searchParams.get(key)!.split(",") : url.searchParams.get(key);
  }
  const cursor = request.headers["last-event-id"];
  if (cursor !== undefined) {
    if (raw.sinceEventId !== undefined && raw.sinceEventId !== cursor)
      throw new HttpError(400, new DaemonError("invalidParams", "Conflicting event cursors"));
    raw.sinceEventId = cursor;
  }
  let subscription: string | undefined;
  const stream = new BufferedStream<DaemonEvent>(() => {
    if (subscription) service.unsubscribe(subscription);
  });
  try {
    subscription = service.subscribe(validateEventFilter(raw), (event) => stream.push(event));
  } catch (error) {
    await stream.close();
    throw new HttpError(
      toDaemonError(error).code === "eventHistoryLost" ? 409 : 400,
      toDaemonError(error),
    );
  }
  if (stream.closed) service.unsubscribe(subscription);
  const close = () => {
    void stream.close();
  };
  response.once("close", close);
  const stopHeartbeat = beginSse(response);
  try {
    for await (const event of stream)
      await writeSse(
        response,
        encodeSse(
          "thread/event",
          { jsonrpc: "2.0", method: "thread/event", params: event },
          event.eventId,
        ),
      );
  } catch (error) {
    sendStreamError(response, error);
  } finally {
    stopHeartbeat();
    response.off("close", close);
    await stream.close();
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    request.on("data", (chunk: Buffer) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        failed = true;
        chunks.length = 0;
        reject(new HttpError(413, new DaemonError("invalidParams", "Request exceeds 1 MiB")));
      } else chunks.push(chunk);
    });
    request.once("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.once("error", reject);
    request.once("aborted", () =>
      reject(new DaemonError("streamInterrupted", "Request body interrupted")),
    );
  });
}

class HttpError extends DaemonError {
  constructor(
    readonly status: number,
    error: DaemonError,
    readonly requestId?: JsonRpcRequest["id"],
  ) {
    super(error.code, error.message, error.data);
  }
}

function sendError(
  response: ServerResponse,
  status: number,
  error: unknown,
  id: JsonRpcRequest["id"] = null,
): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  response.end(JSON.stringify(failure(id, error)));
}

function sendStreamError(response: ServerResponse, error: unknown): void {
  void finishSseError(response, "stream/error", error);
}

async function finishSseError(
  response: ServerResponse,
  event: "response" | "stream/error",
  error: unknown,
  id?: JsonRpcRequest["id"],
): Promise<void> {
  if (response.destroyed || response.writableEnded) return;
  const frame = (failureError: unknown) => {
    const { code, message } = toDaemonError(failureError);
    return encodeSse(
      event,
      event === "response"
        ? failure(id, failureError)
        : { jsonrpc: "2.0", method: "stream/error", params: { code, message } },
    );
  };
  let encoded: string;
  try {
    encoded = frame(error);
  } catch {
    encoded = frame(new DaemonError("streamOverflow", "SSE error frame exceeds its byte limit"));
  }
  try {
    await writeSse(response, encoded);
    response.end();
  } catch {
    response.destroy();
  }
}

function acceptQuality(request: IncomingMessage, type: string): number {
  if (!request.headers.accept) return 1;
  let specificity = -1;
  let quality = 0;
  for (const entry of request.headers.accept.toLowerCase().split(",")) {
    const [media, ...params] = entry.trim().split(";");
    const match =
      media === type ? 2 : media === `${type.split("/")[0]}/*` ? 1 : media === "*/*" ? 0 : -1;
    if (match < 0 || match < specificity) continue;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    const value = q === undefined ? 1 : Number(q.slice(2));
    const valid = Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
    quality = match === specificity ? Math.max(quality, valid) : valid;
    specificity = match;
  }
  return quality;
}
function accepts(request: IncomingMessage, type: string): boolean {
  return acceptQuality(request, type) > 0;
}
