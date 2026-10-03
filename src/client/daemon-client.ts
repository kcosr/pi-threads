import { DaemonError } from "../errors.ts";
import type { DaemonEvent, EventFilter } from "../protocol/events.ts";
import type { AcceptedTurn, ThreadReadResult } from "../protocol/types.ts";
import { BufferedStream } from "../protocol/stream.ts";
import { assertTurnMethod, createTurnStream, type TurnFrame } from "../protocol/turn-stream.ts";
import { validateEventFilter } from "../service/event-bus.ts";
import { HttpClient } from "./http-client.ts";
import { SocketClient } from "./socket-client.ts";
import type { DaemonClientOptions } from "./options.ts";

/** Requests and owned streams, independent of HTTP versus persistent socket framing. */
export class DaemonClient {
  private closed = false;
  private readonly http: HttpClient | undefined;
  private socket: SocketClient | undefined;
  private readonly sockets = new Set<SocketClient>();

  constructor(private readonly options: DaemonClientOptions) {
    if (/^https?:\/\//.test(options.endpoint)) this.http = new HttpClient(options);
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.assertOpen();
    if (method.startsWith("subscribe/") || method.startsWith("unsubscribe/")) {
      throw new DaemonError("invalidParams", "Use subscribe() to own an event stream");
    }
    if (this.http) return this.http.request<T>(method, params);
    this.socket ??= this.openSocket();
    return this.socket.request<T>(method, params);
  }

  async subscribe(filter: EventFilter = {}): Promise<BufferedStream<DaemonEvent>> {
    this.assertOpen();
    const checked = validateEventFilter(filter);
    if (this.http) return this.http.subscribe(checked);
    const socket = this.openSocket();
    const stream = new BufferedStream<DaemonEvent>(() => this.release(socket));
    const listener = (event: DaemonEvent) => stream.push(event);
    socket.on("event", listener);
    socket.on("close", (error) => stream.fail(error));
    try {
      await socket.request("subscribe/all", checked as Record<string, unknown>);
      return stream;
    } catch (error) {
      stream.fail(error);
      throw error;
    }
  }

  async streamTurn(
    method: string,
    params: Record<string, unknown>,
  ): Promise<BufferedStream<TurnFrame>> {
    this.assertOpen();
    assertTurnMethod(method);
    if (this.http) return this.http.streamTurn(method, params);
    let socket: SocketClient | undefined;
    return createTurnStream(
      {
        resolveThreadId: async (input) => {
          const result = await this.request<ThreadReadResult>("thread/read", {
            threadId: input,
            last: 0,
          });
          return result.thread.threadId;
        },
        request: (name, input) => socket!.request<AcceptedTurn>(name, input),
        subscribe: async (filter, listener, onError, signal) => {
          this.assertOpen();
          const connection = this.openSocket();
          socket = connection;
          connection.on("event", listener);
          connection.on("close", onError);
          const dispose = () => {
            signal.removeEventListener("abort", dispose);
            connection.off("event", listener);
            connection.off("close", onError);
            this.release(connection);
          };
          signal.addEventListener("abort", dispose, { once: true });
          try {
            await connection.request("subscribe/all", filter as Record<string, unknown>);
          } catch (error) {
            dispose();
            throw error;
          }
          return dispose;
        },
      },
      method,
      params,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.http?.close();
    await Promise.all([...this.sockets].map((socket) => socket.close()));
    this.sockets.clear();
  }

  private openSocket(): SocketClient {
    this.assertOpen();
    const socket = new SocketClient(this.options);
    this.sockets.add(socket);
    return socket;
  }
  private release(socket: SocketClient): void {
    this.sockets.delete(socket);
    void socket.close();
  }
  private assertOpen(): void {
    if (this.closed) throw new DaemonError("streamInterrupted", "Daemon client closed");
  }
}
