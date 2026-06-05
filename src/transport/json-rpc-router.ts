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

  constructor(private readonly options: JsonRpcConnectionOptions) {
    options.stream.setEncoding("utf8");
    options.stream.on("data", (chunk: string) => void this.handleChunk(chunk));
    options.stream.on("close", () => this.close());
    options.stream.on("error", () => this.close());
  }

  close(): void {
    for (const subscription of this.subscriptions) {
      this.options.service.unsubscribe(subscription);
    }
    this.subscriptions.clear();
  }

  private async handleChunk(chunk: string): Promise<void> {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) {
        return;
      }
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line) {
        continue;
      }
      await this.handleLine(line);
    }
  }

  private async handleLine(line: string): Promise<void> {
    let request: JsonRpcRequest | undefined;
    try {
      request = parseJsonRpcLine(line);
      const result = await this.dispatch(request);
      this.write(success(request.id, result));
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
      this.subscriptions.delete(subscriptionId);
      return { ok: this.options.service.unsubscribe(subscriptionId) };
    }
    const result = await this.options.service.dispatch(request.method, params);
    if (request.method === "server/shutdown") {
      queueMicrotask(() => void this.options.onShutdown?.());
    }
    return result;
  }

  private write(value: unknown): void {
    this.options.stream.write(encodeJsonLine(value));
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
