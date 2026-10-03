import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliRuntime } from "../src/cli/runtime.ts";

const state = vi.hoisted(() => ({
  run: undefined as undefined | ((client: EventEmitter) => void),
}));

vi.mock("../src/client/daemon-client.ts", () => ({
  DaemonClient: class extends EventEmitter {
    async connect() {}
    async request(method: string) {
      if (method === "subscribe/all") return { subscriptionId: "sub-1" };
      state.run?.(this);
      return { threadId: "thread-1", turnId: "turn-1", status: "accepted" };
    }
    async close() {}
  },
}));

vi.mock("../src/config.ts", () => ({
  loadConfig: () => ({}),
  resolveClientConfig: () => ({ endpoint: "unix:///unused" }),
}));

vi.mock("../src/cli/render.ts", () => ({
  printJson: vi.fn(),
  printNdjson: vi.fn(),
  renderHuman: vi.fn(),
  renderEvent: vi.fn(),
  renderThreadRead: vi.fn(),
}));

afterEach(() => {
  state.run = undefined;
});

function terminal(type: string, turnId = "turn-1") {
  return { type, threadId: "thread-1", turnId, payload: { message: "provider failed" } };
}

describe("CLI turn waits", () => {
  it("accepts a terminal event received before the request response", async () => {
    state.run = (client) => client.emit("event", terminal("turn.completed"));
    await expect(
      new CliRuntime(() => ({})).work("thread/send", { prompt: "hello" }),
    ).resolves.toBeUndefined();
  });

  it("reports a failed turn to the caller", async () => {
    state.run = (client) => client.emit("event", terminal("turn.failed"));
    await expect(
      new CliRuntime(() => ({})).work("thread/send", { prompt: "hello" }),
    ).rejects.toThrow("provider failed");
  });

  it("reports an aborted turn to the caller", async () => {
    state.run = (client) => client.emit("event", { ...terminal("turn.aborted"), payload: {} });
    await expect(
      new CliRuntime(() => ({})).work("thread/send", { prompt: "hello" }),
    ).rejects.toThrow("Pi turn aborted");
  });

  it("rejects a wait when the daemon disconnects", async () => {
    state.run = (client) =>
      queueMicrotask(() => client.emit("close", new Error("connection lost")));
    await expect(
      new CliRuntime(() => ({})).work("thread/send", { prompt: "hello" }),
    ).rejects.toThrow("connection lost");
  });

  it("does not mistake another turn's completion for this turn", async () => {
    state.run = (client) => {
      client.emit("event", terminal("turn.completed", "old-turn"));
      client.emit("event", { ...terminal("turn.completed"), turnId: undefined });
      client.emit("event", terminal("turn.failed"));
    };
    await expect(
      new CliRuntime(() => ({})).work("thread/send", { prompt: "hello" }),
    ).rejects.toThrow("provider failed");
  });
});
