import type { Duplex } from "node:stream";
import { DaemonError } from "../errors.ts";
import {
  encodeJsonLine,
  failure,
  parseJsonRpcLine,
  success,
  type JsonRpcRequest,
} from "../protocol/json-rpc.ts";
import type { PiThreadsService } from "../service/pi-threads-service.ts";

export interface JsonRpcConnectionOptions {
  service: PiThreadsService;
  stream: Duplex;
  onShutdown?: () => void | Promise<void>;
}

export class JsonRpcConnection {
  private buffer = "";
  private readonly subscriptions = new Set<string>();
  private closed = false;

  constructor(private readonly options: JsonRpcConnectionOptions) {
    options.stream.setEncoding("utf8");
    options.stream.on("data", (chunk: string) => this.handleChunk(chunk));
    options.stream.on("close", () => this.close());
    options.stream.on("end", () => this.close());
    options.stream.on("error", () => this.close());
  }

  close(): void {
    this.closed = true;
    for (const subscription of this.subscriptions) {
      this.options.service.unsubscribe(subscription);
    }
    this.subscriptions.clear();
  }

  private handleChunk(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    while (!this.closed) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) {
        return;
      }
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line) {
        continue;
      }
      void this.handleLine(line);
    }
  }

  private async handleLine(line: string): Promise<void> {
    let request: JsonRpcRequest | undefined;
    try {
      request = parseJsonRpcLine(line);
      const result = await this.dispatch(request);
      this.write(success(request.id, result), () => {
        if (request?.method === "server/shutdown") {
          void this.options.onShutdown?.();
        }
      });
    } catch (error) {
      this.write(failure(request?.id, error));
    }
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    const params = normalizeParams(request.params);
    if (
      request.method === "subscribe/all" ||
      request.method === "subscribe/thread" ||
      request.method === "subscribe/workers"
    ) {
      const filter =
        request.method === "subscribe/workers"
          ? {
              ...params,
              eventTypes: params.eventTypes ?? ["worker.started", "worker.idle", "worker.crashed"],
            }
          : params;
      const subscriptionId = this.options.service.subscribe(filter, (event) => {
        this.write({ jsonrpc: "2.0", method: "thread/event", params: event });
      });
      this.subscriptions.add(subscriptionId);
      return { subscriptionId };
    }
    if (request.method.startsWith("unsubscribe/")) {
      const subscriptionId = String(params.subscriptionId ?? "");
      if (!subscriptionId) {
        throw new DaemonError("invalidParams", "subscriptionId is required");
      }
      return {
        ok:
          this.subscriptions.delete(subscriptionId) &&
          this.options.service.unsubscribe(subscriptionId),
      };
    }
    return this.options.service.dispatch(request.method, params);
  }

  private write(value: unknown, onWritten?: () => void): void {
    if (this.closed || this.options.stream.destroyed) {
      onWritten?.();
      return;
    }
    this.options.stream.write(encodeJsonLine(value), () => onWritten?.());
  }
}

function normalizeParams(params: unknown): Record<string, any> {
  if (params === undefined || params === null) {
    return {};
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new DaemonError("invalidParams", "JSON-RPC params must be an object");
  }
  return params as Record<string, any>;
}
