import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
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

  it("releases subscriptions when the input stream ends", async () => {
    const stream = new MemoryDuplex();
    const unsubscribe = vi.fn(() => true);
    new JsonRpcConnection({
      stream,
      service: { subscribe: () => "owned", unsubscribe } as any,
    });
    stream.inject('{"jsonrpc":"2.0","id":"1","method":"subscribe/all"}\n');
    await stream.nextOutput();
    stream.push(null);
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledExactlyOnceWith("owned"));
    stream.destroy();
  });

  it("does not unsubscribe a different connection's subscription", async () => {
    const stream = new MemoryDuplex();
    const unsubscribe = vi.fn(() => true);
    new JsonRpcConnection({ stream, service: { unsubscribe } as any });
    stream.inject(
      '{"jsonrpc":"2.0","id":"1","method":"unsubscribe/all","params":{"subscriptionId":"other-client"}}\n',
    );
    expect(JSON.parse(await stream.nextOutput()).result).toEqual({ ok: false });
    expect(unsubscribe).not.toHaveBeenCalled();
    stream.destroy();
  });

  it("still shuts down when the requester disconnects before the service responds", async () => {
    const stream = new MemoryDuplex();
    let resolveRequest: (value: unknown) => void = () => undefined;
    const onShutdown = vi.fn();
    const dispatch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    new JsonRpcConnection({ stream, service: { dispatch } as any, onShutdown });
    stream.inject('{"jsonrpc":"2.0","id":"1","method":"server/shutdown"}\n');
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    stream.destroy();
    resolveRequest({ ok: true });
    await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledOnce());
  });

  it("dispatches aborts while an earlier request in the same chunk is still pending", async () => {
    const stream = new MemoryDuplex();
    let finishBash: (value: unknown) => void = () => undefined;
    const dispatch = vi.fn((method: string) =>
      method === "thread/bash/run"
        ? new Promise((resolve) => {
            finishBash = resolve;
          })
        : Promise.resolve({ aborted: true }),
    );
    new JsonRpcConnection({ stream, service: { dispatch } as any });
    stream.inject(
      '{"jsonrpc":"2.0","id":"bash","method":"thread/bash/run"}\n' +
        '{"jsonrpc":"2.0","id":"abort","method":"thread/bash/abort"}\n',
    );
    expect(JSON.parse(await stream.nextOutput())).toMatchObject({
      id: "abort",
      result: { aborted: true },
    });
    finishBash({ output: "stopped" });
    expect(JSON.parse(await stream.nextOutput())).toMatchObject({
      id: "bash",
      result: { output: "stopped" },
    });
    stream.destroy();
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
