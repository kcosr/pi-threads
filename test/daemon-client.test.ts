import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const constructedSockets: Array<{ endpoint: string; options: Record<string, unknown> }> = [];

vi.mock("ws", () => ({
  default: class FakeWebSocket extends EventEmitter {
    constructor(endpoint: string, options: Record<string, unknown>) {
      super();
      constructedSockets.push({ endpoint, options });
      queueMicrotask(() => this.emit("open"));
    }

    send(): void {}

    close(): void {
      this.emit("close");
    }
  },
}));

import { DaemonClient } from "../src/client/daemon-client.ts";

describe("DaemonClient WebSocket TLS", () => {
  beforeEach(() => {
    constructedSockets.length = 0;
  });

  it("loads a configured CA into a dedicated HTTPS agent", async () => {
    const caPath = join(tmpdir(), `pi-threads-client-ca-${process.pid}.pem`);
    writeFileSync(caPath, "test private CA");
    const client = new DaemonClient({
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
  });
});
