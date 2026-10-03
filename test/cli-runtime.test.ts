import { afterEach, describe, expect, it, vi } from "vitest";
import { CliRuntime } from "../src/cli/runtime.ts";
import { printJson, printNdjson, renderEvent } from "../src/cli/render.ts";

const state = vi.hoisted(() => ({
  terminal: "turn.completed",
  interrupted: false,
  request: vi.fn(),
  streamTurn: vi.fn(),
  close: vi.fn(),
  streamClose: vi.fn(),
}));
const accepted = {
  threadId: "thread-1",
  turnId: "turn-1",
  workerId: "worker-1",
  status: "accepted",
};
vi.mock("../src/client/daemon-client.ts", () => ({
  DaemonClient: class {
    async request() {
      state.request();
      return accepted;
    }
    async streamTurn() {
      state.streamTurn();
      return {
        close: state.streamClose,
        async *[Symbol.asyncIterator]() {
          yield { type: "accepted", result: accepted };
          if (state.interrupted) throw new Error("connection lost");
          yield {
            type: "event",
            event: { type: state.terminal, threadId: "thread-1", turnId: "turn-1", payload: {} },
          };
        },
      };
    }
    async close() {
      state.close();
    }
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
  state.terminal = "turn.completed";
  state.interrupted = false;
  vi.clearAllMocks();
});

describe("CLI turn modes", () => {
  it("waits by default, emitting only the acceptance JSON", async () => {
    await new CliRuntime(() => ({ json: true })).work("thread/send", { prompt: "hello" });
    expect(state.streamTurn).toHaveBeenCalledOnce();
    expect(printJson).toHaveBeenCalledExactlyOnceWith(accepted);
    expect(renderEvent).not.toHaveBeenCalled();
    expect(state.streamClose).toHaveBeenCalledOnce();
    expect(state.close).toHaveBeenCalledOnce();
  });
  it("renders streamed acceptance and events as NDJSON", async () => {
    await new CliRuntime(() => ({ json: true, stream: true })).work("thread/send", {
      prompt: "hello",
    });
    expect(printNdjson).toHaveBeenCalledExactlyOnceWith(accepted);
    expect(renderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.completed" }),
      true,
    );
  });
  it.each([
    { wait: false },
    { wait: false, stream: true, json: true },
  ])("no-wait takes precedence: %j", async (options) => {
    await new CliRuntime(() => options).work("thread/send", { prompt: "hello" });
    expect(state.request).toHaveBeenCalledOnce();
    expect(state.streamTurn).not.toHaveBeenCalled();
    expect(renderEvent).not.toHaveBeenCalled();
  });
  it("promptless new returns acceptance without a turn wait", async () => {
    await new CliRuntime(() => ({ stream: true })).work("thread/start", {});
    expect(state.request).toHaveBeenCalledOnce();
    expect(state.streamTurn).not.toHaveBeenCalled();
  });
  it.each(["turn.failed", "turn.aborted"])("renders %s then reports failure", async (type) => {
    state.terminal = type;
    await expect(
      new CliRuntime(() => ({ stream: true })).work("thread/send", { prompt: "hi" }),
    ).rejects.toThrow(type === "turn.failed" ? "Pi turn failed" : "Pi turn aborted");
    expect(renderEvent).toHaveBeenCalledWith(expect.objectContaining({ type }), false);
    expect(state.streamClose).toHaveBeenCalledOnce();
    expect(state.close).toHaveBeenCalledOnce();
  });
  it("reports interrupted streams instead of succeeding", async () => {
    state.interrupted = true;
    await expect(new CliRuntime(() => ({})).work("thread/send", { prompt: "hi" })).rejects.toThrow(
      "connection lost",
    );
    expect(state.close).toHaveBeenCalledOnce();
  });
});
