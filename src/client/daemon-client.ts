import net from "node:net";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { DaemonError } from "../errors.ts";
import type { DaemonEvent } from "../protocol/events.ts";
import { encodeJsonLine } from "../protocol/json-rpc.ts";

export interface DaemonClientOptions {
  endpoint: string;
  authToken?: string;
  authTokenEnv?: string;
  tlsCa?: string;
}

export class DaemonClient extends EventEmitter {
  private nextId = 1;
  private transport: ClientTransport | undefined;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();

  constructor(private readonly options: DaemonClientOptions) {
    super();
  }

  async connect(): Promise<void> {
    this.transport = await connectTransport(this.options);
    this.transport.onMessage((line) => this.handleLine(line));
    this.transport.onClose(() => {
      for (const pending of this.pending.values()) {
        pending.reject(new DaemonError("workerCrashed", "Daemon connection closed"));
      }
      this.pending.clear();
    });
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.transport) {
      await this.connect();
    }
    const id = String(this.nextId++);
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.transport!.send(
      encodeJsonLine({
        jsonrpc: "2.0",
        id,
        method,
        params: params ?? {},
      }),
    );
    return result;
  }

  async close(): Promise<void> {
    this.transport?.close();
  }

  private handleLine(line: string): void {
    const payload = JSON.parse(line) as Record<string, any>;
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
    if (payload.error) {
      pending.reject(
        new DaemonError(payload.error.code, payload.error.message, payload.error.data),
      );
    } else {
      pending.resolve(payload.result);
    }
  }
}

interface ClientTransport {
  send(line: string): void;
  close(): void;
  onMessage(callback: (line: string) => void): void;
  onClose(callback: () => void): void;
}

async function connectTransport(options: DaemonClientOptions): Promise<ClientTransport> {
  if (options.endpoint.startsWith("unix://")) {
    const socketPath = options.endpoint.slice("unix://".length);
    return connectUnix(socketPath);
  }
  if (options.endpoint.startsWith("ws://") || options.endpoint.startsWith("wss://")) {
    return connectWebSocket(options);
  }
  throw new DaemonError("invalidParams", "Unsupported endpoint", { endpoint: options.endpoint });
}

async function connectUnix(path: string): Promise<ClientTransport> {
  const socket = net.createConnection(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return new LineTransport(socket);
}

async function connectWebSocket(options: DaemonClientOptions): Promise<ClientTransport> {
  const token =
    options.authToken ?? (options.authTokenEnv ? process.env[options.authTokenEnv] : undefined);
  const socket = new WebSocket(options.endpoint, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return new WebSocketTransport(socket);
}

class LineTransport implements ClientTransport {
  private buffer = "";
  private messageCallback: ((line: string) => void) | undefined;
  private closeCallback: (() => void) | undefined;

  constructor(private readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.consume(chunk));
    socket.on("close", () => this.closeCallback?.());
  }

  send(line: string): void {
    this.socket.write(line);
  }

  close(): void {
    this.socket.end();
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
  }

  send(line: string): void {
    this.socket.send(line);
  }

  close(): void {
    this.socket.close();
  }

  onMessage(callback: (line: string) => void): void {
    this.messageCallback = callback;
  }

  onClose(callback: () => void): void {
    this.closeCallback = callback;
  }
}
