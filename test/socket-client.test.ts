import { EventEmitter } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const constructedSockets: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
const sockets: Array<EventEmitter & { respond: boolean; failSend: boolean }> = [];

vi.mock("ws", () => ({
  default: class FakeWebSocket extends EventEmitter {
    respond = true;
    failSend = false;
    constructor(endpoint: string, options: Record<string, unknown>) {
      super();
      constructedSockets.push({ endpoint, options });
      sockets.push(this);
      queueMicrotask(() => this.emit("open"));
    }

    send(line: string): void {
      if (this.failSend) throw new Error("write failed");
      if (!this.respond) return;
      const request = JSON.parse(line);
      queueMicrotask(() =>
        this.emit(
          "message",
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method }),
        ),
      );
    }

    terminate(): void {
      this.close();
    }

    close(): void {
      this.emit("close");
    }
  },
}));

import { SocketClient } from "../src/client/socket-client.ts";

describe("SocketClient WebSocket TLS", () => {
  beforeEach(() => {
    constructedSockets.length = 0;
    sockets.length = 0;
  });

  it("loads a configured CA into a dedicated HTTPS agent", async () => {
    const caPath = join(tmpdir(), `pi-threads-client-ca-${process.pid}.pem`);
    writeFileSync(caPath, "test private CA");
    const client = new SocketClient({
      endpoint: "wss://daemon.test:8765",
      authToken: "secret",
      tlsCa: caPath,
    });

    await client.connect();

    expect(constructedSockets).toHaveLength(1);
    expect(constructedSockets[0]?.endpoint).toBe("wss://daemon.test:8765");
    expect(constructedSockets[0]?.options.headers).toEqual({
      Authorization: "Bearer secret",
    });
    const agent = constructedSockets[0]?.options.agent;
    expect(agent).toBeInstanceOf(https.Agent);
    expect((agent as https.Agent).options.ca?.toString()).toBe("test private CA");
    await client.close();
    rmSync(caPath);
  });

  it("shares one connection for concurrent first requests", async () => {
    const client = new SocketClient({ endpoint: "ws://daemon.test" });
    try {
      expect(await Promise.all([client.request("one"), client.request("two")])).toEqual([
        "one",
        "two",
      ]);
      await client.connect();
      expect(constructedSockets).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("rejects pending and future requests after disconnection", async () => {
    const client = new SocketClient({ endpoint: "ws://daemon.test" });
    await client.connect();
    sockets[0]!.respond = false;
    const pending = expect(client.request("wait")).rejects.toMatchObject({ code: "workerCrashed" });
    await Promise.resolve();
    sockets[0]!.emit("close");
    await pending;
    await expect(client.request("later")).rejects.toMatchObject({ code: "workerCrashed" });
  });

  it("rejects failed sends and tolerates later close", async () => {
    const client = new SocketClient({ endpoint: "ws://daemon.test" });
    await client.connect();
    sockets[0]!.failSend = true;
    await expect(client.request("fail")).rejects.toThrow("write failed");
    await client.close();
  });

  it("rejects pending requests on explicit close", async () => {
    const client = new SocketClient({ endpoint: "ws://daemon.test" });
    await client.connect();
    sockets[0]!.respond = false;
    const pending = expect(client.request("wait")).rejects.toMatchObject({ code: "workerCrashed" });
    await Promise.resolve();
    await client.close();
    await pending;
  });

  it("rejects requests closed while awaiting an already open connection", async () => {
    const client = new SocketClient({ endpoint: "ws://daemon.test" });
    await client.connect();
    const pending = expect(client.request("racing")).rejects.toMatchObject({
      code: "workerCrashed",
    });
    await client.close();
    await pending;
  });
});
