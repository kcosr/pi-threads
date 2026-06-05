import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonRpcConnection } from "../src/transport/json-rpc-router.ts";

describe("JsonRpcConnection", () => {
  it("maps service errors into JSON-RPC errors", async () => {
    const stream = new MemoryDuplex();
    new JsonRpcConnection({
      stream,
      service: {
        dispatch: async () => {
          throw new Error("boom");
        },
        subscribe: () => "sub",
        unsubscribe: () => true,
      } as any,
    });
    stream.inject('{"jsonrpc":"2.0","id":"1","method":"missing","params":{}}\n');
    const response = await stream.nextOutput();
    expect(JSON.parse(response).error.code).toBe("internal");
  });

  it("sends subscription notifications", async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const stream = new MemoryDuplex();
    new JsonRpcConnection({
      stream,
      service: {
        dispatch: async () => ({}),
        subscribe: (_filter: unknown, listener: (event: unknown) => void) => {
          listeners.push(listener);
          return "sub_1";
        },
        unsubscribe: () => true,
      } as any,
    });
    stream.inject('{"jsonrpc":"2.0","id":"1","method":"subscribe/all","params":{}}\n');
    expect(JSON.parse(await stream.nextOutput()).result.subscriptionId).toBe("sub_1");
    listeners[0]!({ eventId: "1", type: "turn.accepted", timestamp: "now", payload: {} });
    expect(JSON.parse(await stream.nextOutput()).method).toBe("thread/event");
  });
});

class MemoryDuplex extends Duplex {
  private outputs: string[] = [];
  private waiters: Array<(value: string) => void> = [];

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const value = chunk.toString("utf8");
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(value);
    } else {
      this.outputs.push(value);
    }
    callback();
  }

  inject(value: string): void {
    this.push(value);
  }

  async nextOutput(): Promise<string> {
    const output = this.outputs.shift();
    if (output) {
      return output;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
