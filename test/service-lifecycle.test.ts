import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.ts";
import { EventBus } from "../src/service/event-bus.ts";
import { PiThreadsService } from "../src/service/pi-threads-service.ts";
import type { PiSessionCatalog } from "../src/session/catalog.ts";
import type { PiRpcResponse } from "../src/worker/pi-rpc-worker.ts";
import { WorkerPool, type PooledWorker } from "../src/worker/worker-pool.ts";

describe("PiThreadsService Pi 1.0 lifecycle", () => {
  it("releases workers after failed model discovery", async () => {
    const { service, worker } = fixture();
    worker.commandHook = async () => {
      throw new Error("model discovery failed");
    };
    await expect(service.modelsList()).rejects.toThrow("model discovery failed");
    expect(worker.state).toBe("idle");
    worker.commandHook = undefined;
    await expect(service.threadStart({ cwd: worker.cwd })).resolves.toMatchObject({
      status: "accepted",
    });
  });

  it.each([
    "start",
    "send",
  ])("completes handled %s prompts without waiting for agent_settled", async (method) => {
    const { service, worker } = fixture();
    worker.disposition = "handled";
    const accepted =
      method === "start"
        ? await service.threadStart({ cwd: worker.cwd, prompt: "/extension" })
        : await service.threadSend({ threadId: "thread-1", prompt: "/extension" });

    await vi.waitFor(() =>
      expect(terminalEvents(service)).toMatchObject([
        { type: "turn.completed", turnId: accepted.turnId, payload: { disposition: "handled" } },
      ]),
    );
    expect(worker.state).toBe("assigned");
    expect(worker.activeTurnId).toBeUndefined();
    await expect(
      service.threadSend({ threadId: "thread-1", prompt: "next" }),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  it.each([
    "started",
    "queued",
  ] as const)("waits for settlement of %s prompts", async (disposition) => {
    const { service, worker } = fixture();
    worker.disposition = disposition;
    const accepted = await service.threadStart({ cwd: worker.cwd, prompt: "hello" });
    await tick();
    worker.emitEvent({ type: "agent_start" });
    worker.emitEvent({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    expect(terminalEvents(service)).toEqual([]);
    worker.emitEvent({ type: "agent_settled" });
    expect(terminalEvents(service)).toMatchObject([
      { type: "turn.completed", turnId: accepted.turnId },
    ]);
  });

  it("waits for extension-started work before completing its handled prompt", async () => {
    const { service, worker } = fixture();
    worker.commandHook = async (command) => {
      if (command.type !== "prompt") return undefined;
      worker.emitEvent({ type: "agent_start" });
      return success("prompt", { disposition: "handled" });
    };
    await service.threadStart({ cwd: worker.cwd, prompt: "/extension" });
    await tick();
    expect(terminalEvents(service)).toEqual([]);
    worker.emitEvent({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    worker.emitEvent({ type: "agent_settled" });
    expect(terminalEvents(service)).toHaveLength(1);
  });

  it("does not duplicate a fast completion when the handled response arrives later", async () => {
    const { service, worker } = fixture();
    worker.commandHook = async (command) => {
      if (command.type !== "prompt") return undefined;
      worker.emitEvent({ type: "agent_start" });
      worker.emitEvent({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "stop" }],
      });
      worker.emitEvent({ type: "agent_settled" });
      return success("prompt", { disposition: "handled" });
    };
    await service.threadStart({ cwd: worker.cwd, prompt: "/extension" });
    await tick();
    expect(terminalEvents(service)).toHaveLength(1);
  });

  it("reports intercepted queue submissions without inventing pending messages", async () => {
    const { service, worker } = fixture();
    await service.threadStart({ cwd: worker.cwd, prompt: "hello" });
    worker.disposition = "handled";
    await expect(
      service.threadSteer({ threadId: "thread-1", prompt: "intercept" }),
    ).resolves.toMatchObject({ status: "running", disposition: "handled" });
    await expect(
      service.threadFollowUp({ threadId: "thread-1", prompt: "intercept" }),
    ).resolves.toEqual({ threadId: "thread-1", status: "handled" });
    expect(service.events.eventsSince({ eventTypes: ["queue.updated"] })).toEqual([]);
    expect(terminalEvents(service)).toEqual([]);
  });

  it("fails rejected prompts and releases their reservation", async () => {
    const { service, worker } = fixture();
    worker.commandHook = async (command) => {
      if (command.type === "prompt") throw new Error("No model selected");
    };
    const accepted = await service.threadStart({ cwd: worker.cwd, prompt: "hello" });
    await vi.waitFor(() =>
      expect(terminalEvents(service)).toMatchObject([
        { type: "turn.failed", turnId: accepted.turnId, payload: { message: "No model selected" } },
      ]),
    );
    worker.commandHook = undefined;
    await expect(
      service.threadSend({ threadId: "thread-1", prompt: "retry" }),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  it("reports one aborted terminal event and leaves a newer turn active", async () => {
    const { service, worker } = fixture();
    const first = await service.threadStart({ cwd: worker.cwd, prompt: "hello" });
    await tick();
    const abortResponse = deferred<PiRpcResponse>();
    worker.commandHook = async (command) => {
      if (command.type !== "abort") return undefined;
      worker.emitEvent({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "aborted" }],
      });
      worker.emitEvent({ type: "agent_settled" });
      return abortResponse.promise;
    };
    const aborted = service.threadAbort({ threadId: "thread-1" });
    expect(terminalEvents(service)).toMatchObject([{ type: "turn.aborted", turnId: first.turnId }]);
    const next = await service.threadSend({ threadId: "thread-1", prompt: "next" });
    abortResponse.resolve(success("abort"));
    await aborted;
    expect(terminalEvents(service)).toHaveLength(1);
    expect(worker.activeTurnId).toBe(next.turnId);
    expect(worker.state).toBe("running");
  });

  it("waits for the previous turn's catalog refresh before starting a new turn", async () => {
    const { service, worker } = fixture();
    await service.threadStart({ cwd: worker.cwd, prompt: "hello" });
    await tick();
    const oldState = deferred<Record<string, unknown>>();
    worker.getStateHook = () => oldState.promise;
    worker.emitEvent({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    worker.emitEvent({ type: "agent_settled" });
    const sending = service.threadSend({ threadId: "thread-1", prompt: "next" });
    await tick();
    expect(worker.state).toBe("assigned");
    expect(worker.activeTurnId).toBeUndefined();
    oldState.resolve({ sessionId: "thread-1", sessionFile: "/tmp/project/session.jsonl" });
    const next = await sending;
    expect(worker.state).toBe("running");
    expect(worker.activeTurnId).toBe(next.turnId);
  });

  it("does not fail a newer turn when an earlier prompt response rejects late", async () => {
    const { service, worker } = fixture();
    const response = deferred<PiRpcResponse>();
    worker.commandHook = async (command) =>
      command.type === "prompt" ? response.promise : undefined;
    await service.threadStart({ cwd: worker.cwd, prompt: "hello" });
    worker.emitEvent({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    worker.emitEvent({ type: "agent_settled" });
    worker.commandHook = undefined;
    const next = await service.threadSend({ threadId: "thread-1", prompt: "next" });
    response.reject(new Error("late timeout"));
    await tick();
    expect(terminalEvents(service)).toHaveLength(1);
    expect(worker.activeTurnId).toBe(next.turnId);
  });

  it("terminates active turns when their worker crashes", async () => {
    const { service, worker } = fixture();
    const first = await service.threadStart({ cwd: worker.cwd, prompt: "hello" });
    await tick();
    const refresh = vi.spyOn(service.catalog, "updateFromWorkerState");
    const assertUnchanged = vi.spyOn(service.catalog, "assertUnchanged").mockImplementation(() => {
      expect(refresh).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "thread-1",
          sessionFile: "/tmp/project/session.jsonl",
        }),
      );
    });
    worker.state = "crashed";
    worker.emit("exit", { exitCode: 1, signal: null });
    expect(terminalEvents(service)).toMatchObject([
      { type: "turn.failed", turnId: first.turnId, payload: { errorCode: "workerCrashed" } },
    ]);
    await expect(
      service.threadSend({ threadId: "thread-1", prompt: "retry" }),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(assertUnchanged).toHaveBeenCalled();
  });

  it("checks and refreshes ownership around daemon session mutations", async () => {
    const { service, worker } = fixture();
    const assertUnchanged = vi.spyOn(service.catalog, "assertUnchanged");
    const update = vi.spyOn(service.catalog, "updateFromWorkerState");
    let writeFinished = false;
    worker.commandHook = async (command) => {
      if (command.type === "set_thinking_level") {
        expect(assertUnchanged).toHaveBeenCalledWith("thread-1");
        expect(update).not.toHaveBeenCalled();
        writeFinished = true;
      }
    };
    update.mockImplementation(() => expect(writeFinished).toBe(true));
    await service.threadSettingsUpdate({ threadId: "thread-1", thinking: "high" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "thread-1" }));
    expect(worker.state).toBe("assigned");
  });

  it("rejects external changes before issuing session mutations", async () => {
    const { service, worker } = fixture();
    vi.spyOn(service.catalog, "assertUnchanged").mockImplementation(() => {
      throw new Error("external writer");
    });
    const command = vi.spyOn(worker, "command");
    await expect(
      service.threadSettingsUpdate({ threadId: "thread-1", thinking: "high" }),
    ).rejects.toThrow("external writer");
    expect(command).not.toHaveBeenCalled();
  });

  it.each([
    { refreshFailure: "get_state", mutationFails: false },
    { refreshFailure: "get_state", mutationFails: true },
    { refreshFailure: "catalog update", mutationFails: false },
    { refreshFailure: "catalog update", mutationFails: true },
    { refreshFailure: "crashed worker catalog", mutationFails: false },
    { refreshFailure: "crashed worker catalog", mutationFails: true },
  ])("preserves the mutation outcome when $refreshFailure fails (mutationFails=$mutationFails)", async ({
    refreshFailure,
    mutationFails,
  }) => {
    const { service, worker } = fixture();
    const mutationError = new Error("original bash failure");
    const refreshError = new Error("session refresh failed");
    const release = vi.spyOn(service.workers, "release");
    worker.commandHook = async (command) => {
      if (command.type !== "bash") return undefined;
      if (refreshFailure === "get_state") {
        worker.getStateHook = async () => {
          throw refreshError;
        };
      } else if (refreshFailure === "catalog update") {
        vi.spyOn(service.catalog, "updateFromWorkerState").mockImplementation(() => {
          throw refreshError;
        });
      } else {
        worker.state = "crashed";
        vi.spyOn(service.catalog, "resolveThread").mockRejectedValue(refreshError);
      }
      if (mutationFails) throw mutationError;
      return success("bash", { output: "completed output", exitCode: 0 });
    };

    const result = service.threadBashRun({ threadId: "thread-1", command: "echo output" });
    if (mutationFails) {
      await expect(result).rejects.toBe(mutationError);
    } else {
      await expect(result).resolves.toEqual({
        threadId: "thread-1",
        result: { output: "completed output", exitCode: 0 },
      });
    }
    expect(release).toHaveBeenCalledWith(worker);
    expect(service.events.eventsSince({ eventTypes: ["thread.updated"] })).toContainEqual(
      expect.objectContaining({
        threadId: "thread-1",
        workerId: worker.workerId,
        payload: { internalError: "session refresh failed", operation: "session.refresh" },
      }),
    );
  });

  it("excludes overlapping mutations and turns while allowing bash abort", async () => {
    const { service, worker } = fixture();
    const bashResponse = deferred<PiRpcResponse>();
    worker.commandHook = async (command) =>
      command.type === "bash" ? bashResponse.promise : undefined;
    const bash = service.threadBashRun({ threadId: "thread-1", command: "sleep 5" });
    await vi.waitFor(() => expect(worker.state).toBe("running"));
    await expect(
      service.threadSend({ threadId: "thread-1", prompt: "hello" }),
    ).rejects.toMatchObject({ code: "busy" });
    await expect(
      service.threadSettingsUpdate({ threadId: "thread-1", thinking: "high" }),
    ).rejects.toMatchObject({ code: "busy" });
    await expect(service.threadBashAbort({ threadId: "thread-1" })).resolves.toMatchObject({
      status: "aborted",
    });
    bashResponse.resolve(success("bash", { output: "", cancelled: true }));
    await bash;
    expect(worker.state).toBe("assigned");
    await expect(
      service.threadSend({ threadId: "thread-1", prompt: "hello" }),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  it("rejects session mutations during a daemon turn", async () => {
    const { service, worker } = fixture();
    await service.threadStart({ cwd: worker.cwd, prompt: "hello" });
    await expect(service.threadCompact({ threadId: "thread-1" })).rejects.toMatchObject({
      code: "busy",
    });
    await expect(service.threadClone({ threadId: "thread-1" })).rejects.toMatchObject({
      code: "busy",
    });
    await expect(
      service.threadNameSet({ threadId: "thread-1", name: "new" }),
    ).rejects.toMatchObject({ code: "busy" });
  });
});

function fixture() {
  const worker = new FakeWorker();
  const events = new EventBus();
  const workers = new WorkerPool(
    { minWorkers: 0, maxWorkers: 1, idleTtlMs: 300_000, workerFactory: () => worker },
    events,
  );
  const service = new PiThreadsService(defaultConfig(), {
    workers,
    catalog: {
      resolveThread: async () => ({
        id: "thread-1",
        path: "/tmp/project/session.jsonl",
        cwd: worker.cwd,
      }),
      assertUnchanged: () => undefined,
      updateFromWorkerState: () => undefined,
    } as unknown as PiSessionCatalog,
  });
  events.subscribe({}, ({ eventId: _eventId, ...event }) => service.events.emit(event));
  return { service, worker };
}

class FakeWorker extends EventEmitter implements PooledWorker {
  readonly workerId = "worker-1";
  readonly cwd = "/tmp/project";
  readonly startedAt = new Date();
  version = "1.0.0";
  state: PooledWorker["state"] = "starting";
  threadId: string | undefined;
  activeTurnId: string | undefined;
  abortingTurnId: string | undefined;
  lastUsedAt = new Date();
  pid = 123;
  disposition: "started" | "handled" | "queued" = "started";
  commandHook?: (command: Record<string, unknown>) => Promise<PiRpcResponse | undefined>;
  getStateHook?: () => Promise<Record<string, unknown>>;

  async start() {
    this.state = "idle";
  }

  async command(command: Record<string, unknown>): Promise<PiRpcResponse> {
    const result = await this.commandHook?.(command);
    if (result) return result;
    return success(
      String(command.type),
      command.type === "prompt" || command.type === "steer" || command.type === "follow_up"
        ? { disposition: this.disposition }
        : undefined,
    );
  }

  async getState() {
    return (
      this.getStateHook?.() ?? { sessionId: "thread-1", sessionFile: "/tmp/project/session.jsonl" }
    );
  }

  emitEvent(event: Record<string, unknown>) {
    this.emit("event", event);
  }
  sendRaw() {}
  async stop() {
    this.state = "stopped";
  }
}

function success(command: string, data?: unknown): PiRpcResponse {
  return { type: "response", command, success: true, data };
}

function terminalEvents(service: PiThreadsService) {
  return service.events.eventsSince({
    eventTypes: ["turn.completed", "turn.failed", "turn.aborted"],
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
