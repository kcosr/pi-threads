import net from "node:net";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import https from "node:https";
import WebSocket from "ws";
import { DaemonError, type ErrorCode } from "../errors.ts";
import type { DaemonEvent } from "../protocol/events.ts";
import { encodeJsonLine } from "../protocol/json-rpc.ts";

import type { DaemonClientOptions } from "./options.ts";

export class SocketClient extends EventEmitter {
  private nextId = 1;
  private transport: ClientTransport | undefined;
  private connecting: Promise<void> | undefined;
  private readonly connectionAbort = new AbortController();
  private closed = false;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();

  constructor(private readonly options: DaemonClientOptions) {
    super();
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new DaemonError("workerCrashed", "Daemon connection closed");
    }
    if (this.transport) return;
    this.connecting ??= this.openTransport();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async openTransport(): Promise<void> {
    const transport = await connectTransport(this.options, this.connectionAbort.signal);
    if (this.closed) {
      transport.close();
      throw new DaemonError("workerCrashed", "Daemon connection closed");
    }
    this.transport = transport;
    transport.onMessage((line) => this.handleLine(line));
    transport.onClose(() => this.handleClose());
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.connect();
    if (this.closed) throw new DaemonError("workerCrashed", "Daemon connection closed");
    const id = String(this.nextId++);
    const line = encodeJsonLine({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    });
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.transport!.send(line);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    return result;
  }

  async close(): Promise<void> {
    this.handleClose();
    this.transport?.close();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionAbort.abort();
    const error = new DaemonError("workerCrashed", "Daemon connection closed");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emit("close", error);
  }

  private handleLine(line: string): void {
    const payload = safeParseDaemonLine(line);
    if (!payload) {
      return;
    }
    if (payload.method === "thread/event") {
      this.emit("event", payload.params as DaemonEvent);
      return;
    }
    const id = String(payload.id);
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    if (isRecord(payload.error)) {
      pending.reject(
        new DaemonError(
          String(payload.error.code ?? "internal") as ErrorCode,
          String(payload.error.message ?? "Daemon returned an error"),
          isRecord(payload.error.data) ? payload.error.data : undefined,
        ),
      );
    } else {
      pending.resolve(payload.result);
    }
  }
}

function safeParseDaemonLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ClientTransport {
  send(line: string): void;
  close(): void;
  onMessage(callback: (line: string) => void): void;
  onClose(callback: () => void): void;
}

async function connectTransport(
  options: DaemonClientOptions,
  signal: AbortSignal,
): Promise<ClientTransport> {
  if (options.endpoint.startsWith("unix://")) {
    const socketPath = options.endpoint.slice("unix://".length);
    return connectUnix(socketPath, signal);
  }
  if (options.endpoint.startsWith("ws://") || options.endpoint.startsWith("wss://")) {
    return connectWebSocket(options, signal);
  }
  throw new DaemonError("invalidParams", "Unsupported endpoint", { endpoint: options.endpoint });
}

async function connectUnix(path: string, signal: AbortSignal): Promise<ClientTransport> {
  const socket = net.createConnection(path);
  await waitForOpen(socket, "connect", signal, () => socket.destroy());
  return new LineTransport(socket);
}

async function connectWebSocket(
  options: DaemonClientOptions,
  signal: AbortSignal,
): Promise<ClientTransport> {
  const token =
    options.authToken ?? (options.authTokenEnv ? process.env[options.authTokenEnv] : undefined);
  const agent = options.tlsCa ? new https.Agent({ ca: readFileSync(options.tlsCa) }) : undefined;
  const socket = new WebSocket(options.endpoint, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    agent,
  });
  socket.once("close", () => agent?.destroy());
  await waitForOpen(socket, "open", signal, () => socket.terminate());
  return new WebSocketTransport(socket);
}

function waitForOpen(
  socket: EventEmitter,
  readyEvent: string,
  signal: AbortSignal,
  close: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off(readyEvent, onReady);
      socket.off("error", onError);
      socket.off("close", onClose);
      signal.removeEventListener("abort", onClose);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      // Bun can emit multiple errors while terminating an unfinished handshake.
      socket.on("error", () => {});
      close();
      reject(error);
    };
    const onClose = () => onError(new DaemonError("workerCrashed", "Daemon connection closed"));
    socket.once(readyEvent, onReady);
    socket.once("error", onError);
    socket.once("close", onClose);
    signal.addEventListener("abort", onClose, { once: true });
    if (signal.aborted) onClose();
  });
}

class LineTransport implements ClientTransport {
  private buffer = "";
  private messageCallback: ((line: string) => void) | undefined;
  private closeCallback: (() => void) | undefined;

  constructor(private readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.consume(chunk));
    socket.on("close", () => this.closeCallback?.());
    socket.on("error", () => socket.destroy());
  }

  send(line: string): void {
    this.socket.write(line);
  }

  close(): void {
    this.socket.destroy();
  }

  onMessage(callback: (line: string) => void): void {
    this.messageCallback = callback;
  }

  onClose(callback: () => void): void {
    this.closeCallback = callback;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) {
        return;
      }
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        this.messageCallback?.(line);
      }
    }
  }
}

class WebSocketTransport implements ClientTransport {
  private messageCallback: ((line: string) => void) | undefined;
  private closeCallback: (() => void) | undefined;

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      for (const line of data.toString().split("\n")) {
        if (line) {
          this.messageCallback?.(line);
        }
      }
    });
    socket.on("close", () => this.closeCallback?.());
    socket.on("error", () => socket.terminate());
  }

  send(line: string): void {
    this.socket.send(line);
  }

  close(): void {
    this.socket.terminate();
  }

  onMessage(callback: (line: string) => void): void {
    this.messageCallback = callback;
  }

  onClose(callback: () => void): void {
    this.closeCallback = callback;
  }
}
