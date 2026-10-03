import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.ts";
import { EventBus } from "../src/service/event-bus.ts";
import { PiThreadsService } from "../src/service/pi-threads-service.ts";
import type { PiRpcResponse } from "../src/worker/pi-rpc-worker.ts";
import { WorkerPool, type PooledWorker } from "../src/worker/worker-pool.ts";

const fixtures: Array<{ service: PiThreadsService; root: string }> = [];

afterEach(async () => {
  for (const { service, root } of fixtures.splice(0)) {
    await service.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("PiThreadsService worker lifetimes", () => {
  it.each([
    true,
    false,
  ])("preserves unpersisted threads until Pi saves them with reuseAcrossThreads=%s", async (reuseAcrossThreads) => {
    const { service, created, cwdA, cwdB } = await fixture({
      reuseAcrossThreads,
      persistOnStart: false,
    });
    const first = await service.threadStart({ cwd: cwdA, name: "keep this thread" });
    const worker = created[0]!;
    await waitForIdle(service, worker, 1);
    const session = await service.catalog.resolveThread(first.threadId);
    expect(existsSync(session.path)).toBe(false);

    await expect(service.threadStart({ cwd: cwdA })).rejects.toMatchObject({ code: "capacity" });
    await expect(service.threadStart({ cwd: cwdB })).rejects.toMatchObject({ code: "capacity" });
    const next = await service.threadSend({ threadId: first.threadId, prompt: "/handled" });
    await waitForIdle(service, worker, 2);
    expect(next.workerId).toBe(first.workerId);
    expect(worker.sessionState()).toMatchObject({
      sessionId: first.threadId,
      sessionName: "keep this thread",
    });
    expect(existsSync(session.path)).toBe(false);
    expect(created).toHaveLength(1);

    worker.persistSession();
    const second = await service.threadStart({ cwd: cwdA });
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.workerId === first.workerId).toBe(reuseAcrossThreads);
    expect(created).toHaveLength(reuseAcrossThreads ? 1 : 2);
  });

  it.each([
    "send",
    "read",
    "mutation",
  ] as const)("fails %s of an unpersisted thread after its worker crashes without allocating a replacement", async (operation) => {
    const { service, created, cwdA } = await fixture({ persistOnStart: false });
    const first = await service.threadStart({ cwd: cwdA });
    const worker = created[0]!;
    await waitForIdle(service, worker, 1);
    worker.state = "crashed";
    worker.emit("exit", { exitCode: 1, signal: null });
    expect(service.workers.list()).toHaveLength(0);
    const result =
      operation === "send"
        ? service.threadSend({ threadId: first.threadId, prompt: "/handled" })
        : operation === "read"
          ? service.threadCommandsList({ threadId: first.threadId })
          : service.threadNameSet({ threadId: first.threadId, name: "cannot restore" });
    await expect(result).rejects.toMatchObject({ code: "notFound" });
    expect(created).toHaveLength(1);
    expect(service.workers.list()).toHaveLength(0);
    expect(worker.commands.some((command) => command.type === "switch_session")).toBe(false);
  });

  it("keeps the worker for subsequent turns of its bound thread", async () => {
    const { service, created, cwdA } = await fixture();
    const first = await service.threadStart({ cwd: cwdA });
    const worker = created[0]!;
    await waitForIdle(service, worker, 1);

    const next = await service.threadSend({ threadId: first.threadId, prompt: "continue" });
    await waitForIdle(service, worker, 2);
    const final = await service.threadSend({ threadId: first.threadId, prompt: "continue again" });
    await waitForIdle(service, worker, 3);

    expect(next.workerId).toBe(first.workerId);
    expect(final.workerId).toBe(first.workerId);
    expect(created).toHaveLength(1);
    expect(worker.commands.filter((command) => command.type === "new_session")).toHaveLength(1);
    expect(worker.commands.some((command) => command.type === "switch_session")).toBe(false);
  });

  it("replaces an idle worker at capacity and resumes the saved thread in its original cwd", async () => {
    const { service, created, cwdA, cwdB } = await fixture();
    const first = await service.threadStart({ cwd: cwdA });
    await waitForIdle(service, created[0]!, 1);
    const saved = await service.catalog.resolveThread(first.threadId);

    const second = await service.threadStart({ cwd: cwdB });
    await waitForIdle(service, created[1]!, 1);
    expect(second.workerId).not.toBe(first.workerId);
    expect(created[0]!.state).toBe("stopped");

    const resumed = await service.threadSend({ threadId: first.threadId, prompt: "resume" });
    await waitForIdle(service, created[2]!, 1);
    expect(resumed.threadId).toBe(first.threadId);
    expect(resumed.workerId).not.toBe(first.workerId);
    expect(created[1]!.state).toBe("stopped");
    expect(created[2]!.cwd).toBe(cwdA);
    expect(created[2]!.commands[0]).toEqual({ type: "switch_session", sessionPath: saved.path });
    expect(service.workers.list()).toHaveLength(1);
  });

  it("does not evict an active turn and admits another thread after settlement", async () => {
    const { service, created, cwdA, cwdB } = await fixture();
    const first = await service.threadStart({ cwd: cwdA });
    const worker = created[0]!;
    await waitForIdle(service, worker, 1);
    worker.disposition = "started";
    await service.threadSend({ threadId: first.threadId, prompt: "work" });
    await expect(service.threadStart({ cwd: cwdB })).rejects.toMatchObject({ code: "capacity" });
    expect(worker.state).toBe("running");
    expect(created).toHaveLength(1);

    worker.settle();
    await waitForIdle(service, worker, 2);
    await expect(service.threadStart({ cwd: cwdB })).resolves.toMatchObject({ status: "accepted" });
    expect(worker.state).toBe("stopped");
  });

  it("protects a loaded thread while a read command is pending", async () => {
    const { service, created, cwdA, cwdB } = await fixture();
    const first = await service.threadStart({ cwd: cwdA });
    const worker = created[0]!;
    await waitForIdle(service, worker, 1);
    const entered = deferred<void>();
    const response = deferred<PiRpcResponse>();
    worker.commandHook = async (command) => {
      if (command.type !== "get_messages") return undefined;
      entered.resolve();
      return response.promise;
    };
    const reading = service.threadMessages({ threadId: first.threadId });
    await entered.promise;
    await expect(service.threadStart({ cwd: cwdB })).rejects.toMatchObject({ code: "capacity" });
    expect(worker.state).toBe("assigned");

    response.resolve(
      success("get_messages", { messages: [{ role: "assistant", content: "done" }] }),
    );
    await expect(reading).resolves.toMatchObject({
      messages: [{ role: "assistant", content: "done" }],
    });
    await expect(service.threadStart({ cwd: cwdB })).resolves.toMatchObject({ status: "accepted" });
    expect(worker.state).toBe("stopped");
  });

  it("accepts a same-thread send behind a pending read while protecting the worker from eviction", async () => {
    const { service, created, cwdA, cwdB } = await fixture();
    const first = await service.threadStart({ cwd: cwdA });
    const worker = created[0]!;
    await waitForIdle(service, worker, 1);
    const entered = deferred<void>();
    const response = deferred<PiRpcResponse>();
    worker.commandHook = async (command) => {
      if (command.type !== "get_messages") return undefined;
      entered.resolve();
      return response.promise;
    };
    const reading = service.threadMessages({ threadId: first.threadId });
    await entered.promise;

    const sending = await service.threadSend({ threadId: first.threadId, prompt: "continue" });
    expect(sending.workerId).toBe(first.workerId);
    expect(
      service.events.eventsSince({ turnId: sending.turnId, eventTypes: ["turn.completed"] }),
    ).toEqual([]);
    await expect(service.threadStart({ cwd: cwdB })).rejects.toMatchObject({ code: "capacity" });
    await expect(
      service.threadSend({ threadId: first.threadId, prompt: "overlap" }),
    ).rejects.toMatchObject({ code: "busy" });

    response.resolve(success("get_messages", { messages: [] }));
    await reading;
    await waitForIdle(service, worker, 2);
    expect(
      service.events.eventsSince({ turnId: sending.turnId, eventTypes: ["turn.completed"] }),
    ).toHaveLength(1);
    expect(created).toHaveLength(1);
    await expect(service.threadStart({ cwd: cwdB })).resolves.toMatchObject({ status: "accepted" });
  });

  it("queues a same-thread mutation behind a pending read while protecting the worker from eviction", async () => {
    const { service, created, cwdA, cwdB } = await fixture();
    const first = await service.threadStart({ cwd: cwdA });
    const worker = created[0]!;
    await waitForIdle(service, worker, 1);
    const entered = deferred<void>();
    const response = deferred<PiRpcResponse>();
    worker.commandHook = async (command) => {
      if (command.type !== "get_messages") return undefined;
      entered.resolve();
      return response.promise;
    };
    const reading = service.threadMessages({ threadId: first.threadId });
    await entered.promise;
    let settled = false;
    const mutating = service
      .threadSettingsUpdate({ threadId: first.threadId, thinking: "high" })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() =>
      expect(worker.commands).toContainEqual({ type: "set_thinking_level", level: "high" }),
    );
    expect(settled).toBe(false);
    await expect(service.threadStart({ cwd: cwdB })).rejects.toMatchObject({ code: "capacity" });
    await expect(
      service.threadNameSet({ threadId: first.threadId, name: "overlap" }),
    ).rejects.toMatchObject({ code: "busy" });

    response.resolve(success("get_messages", { messages: [] }));
    await reading;
    await expect(mutating).resolves.toMatchObject({ result: { threadId: first.threadId } });
    expect(created).toHaveLength(1);
    await expect(service.threadStart({ cwd: cwdB })).resolves.toMatchObject({ status: "accepted" });
  });

  it("protects the complete settings mutation and releases it after its metadata refresh", async () => {
    const { service, created, cwdA, cwdB } = await fixture();
    const first = await service.threadStart({ cwd: cwdA });
    const worker = created[0]!;
    await waitForIdle(service, worker, 1);
    const entered = deferred<void>();
    const response = deferred<PiRpcResponse>();
    worker.commandHook = async (command) => {
      if (command.type !== "set_thinking_level") return undefined;
      entered.resolve();
      return response.promise;
    };
    const mutating = service.threadSettingsUpdate({
      threadId: first.threadId,
      model: "mock/default",
      thinking: "high",
      autoRetry: false,
    });
    await entered.promise;
    expect(worker.commands).toContainEqual({
      type: "set_model",
      provider: "mock",
      modelId: "default",
    });
    await expect(service.threadStart({ cwd: cwdB })).rejects.toMatchObject({ code: "capacity" });

    response.resolve(success("set_thinking_level"));
    await mutating;
    expect(worker.commands).toContainEqual({ type: "set_auto_retry", enabled: false });
    await expect(service.threadStart({ cwd: cwdB })).resolves.toMatchObject({ status: "accepted" });
    expect(worker.state).toBe("stopped");
  });

  it("retains a settled worker until turn metadata cleanup finishes", async () => {
    const { service, created, cwdA, cwdB } = await fixture();
    const first = await service.threadStart({ cwd: cwdA });
    const worker = created[0]!;
    await waitForIdle(service, worker, 1);
    worker.disposition = "started";
    await service.threadSend({ threadId: first.threadId, prompt: "work" });
    const refreshing = deferred<void>();
    const state = deferred<Record<string, unknown>>();
    worker.getStateHook = () => {
      refreshing.resolve();
      return state.promise;
    };
    worker.settle();
    await refreshing.promise;
    expect(worker.activeTurnId).toBeUndefined();
    expect(worker.state).toBe("assigned");
    await expect(service.threadStart({ cwd: cwdB })).rejects.toMatchObject({ code: "capacity" });

    state.resolve(worker.sessionState());
    await waitForIdle(service, worker, 2);
    await expect(service.threadStart({ cwd: cwdB })).resolves.toMatchObject({ status: "accepted" });
    expect(worker.state).toBe("stopped");
  });

  it("releases the worker reservation when settings fail before a turn starts", async () => {
    const { service, created, cwdA, cwdB } = await fixture();
    const first = await service.threadStart({ cwd: cwdA });
    const worker = created[0]!;
    await waitForIdle(service, worker, 1);
    worker.commandHook = async (command) => {
      if (command.type === "set_thinking_level") throw new Error("settings rejected");
    };
    await expect(
      service.threadSend({ threadId: first.threadId, prompt: "work", thinking: "high" }),
    ).rejects.toThrow("settings rejected");
    expect(worker.commands.some((command) => command.type === "prompt")).toBe(false);
    await expect(service.threadStart({ cwd: cwdB })).resolves.toMatchObject({ status: "accepted" });

    const retry = await service.threadSend({ threadId: first.threadId, prompt: "retry" });
    expect(retry.threadId).toBe(first.threadId);
    expect(created[2]!.cwd).toBe(cwdA);
  });

  it.each([
    "fork",
    "clone",
  ] as const)("rejects %s with thread reuse disabled before issuing a worker command", async (operation) => {
    const { service, created, cwdA } = await fixture();
    const first = await service.threadStart({ cwd: cwdA });
    const worker = created[0]!;
    await waitForIdle(service, worker, 1);
    const commandCount = worker.commands.length;
    const result =
      operation === "fork"
        ? service.threadFork({ threadId: first.threadId, entryId: "entry-1" })
        : service.threadClone({ threadId: first.threadId });
    await expect(result).rejects.toMatchObject({
      code: "invalidParams",
      message: expect.stringContaining("reuseAcrossThreads=true"),
    });
    expect(worker.commands).toHaveLength(commandCount);
    expect(worker.threadId).toBe(first.threadId);
  });
});

async function fixture(options: { reuseAcrossThreads?: boolean; persistOnStart?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-threads-worker-lifetimes-"));
  const cwdA = join(root, "a");
  const cwdB = join(root, "b");
  mkdirSync(cwdA);
  mkdirSync(cwdB);
  const created: FakeWorker[] = [];
  const events = new EventBus();
  const config = defaultConfig();
  config.daemon.worker = {
    minWorkers: 0,
    maxWorkers: 1,
    idleTtlMs: 0,
    reuseAcrossThreads: options.reuseAcrossThreads ?? false,
  };
  let service: PiThreadsService;
  const pool = new WorkerPool(
    {
      ...config.daemon.worker,
      canReclaim: (worker) => !worker.threadId || service.catalog.isPersisted(worker.threadId),
      workerFactory: ({ workerId, cwd }) => {
        const worker = new FakeWorker(workerId, cwd, root, options.persistOnStart ?? true);
        created.push(worker);
        return worker;
      },
    },
    events,
  );
  service = new PiThreadsService(config, { workers: pool });
  events.subscribe({}, ({ eventId: _eventId, ...event }) => service.events.emit(event));
  fixtures.push({ service, root });
  await service.start();
  return { service, created, cwdA, cwdB };
}

class FakeWorker extends EventEmitter implements PooledWorker {
  readonly startedAt = new Date();
  version = "1.0.0";
  state: PooledWorker["state"] = "starting";
  threadId: string | undefined;
  activeTurnId: string | undefined;
  lastUsedAt = new Date();
  pid = 123;
  disposition: "handled" | "started" = "handled";
  readonly commands: Array<Record<string, unknown>> = [];
  commandHook?: (command: Record<string, unknown>) => Promise<PiRpcResponse | undefined>;
  getStateHook?: () => Promise<Record<string, unknown>>;
  private sessionId = "";
  private sessionFile = "";
  private sessionName: string | undefined;
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly workerId: string,
    readonly cwd: string,
    private readonly root: string,
    private readonly persistOnStart: boolean,
  ) {
    super();
  }

  async start() {
    this.state = "idle";
  }

  command(command: Record<string, unknown>): Promise<PiRpcResponse> {
    this.commands.push(command);
    const queued = this.commandQueue.then(() => this.executeCommand(command));
    this.commandQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async executeCommand(command: Record<string, unknown>): Promise<PiRpcResponse> {
    const result = await this.commandHook?.(command);
    if (result) return result;
    if (command.type === "new_session") {
      this.sessionId = `session-${this.workerId}-${this.commands.length}`;
      this.sessionFile = join(this.root, `${this.sessionId}.jsonl`);
      this.sessionName = undefined;
      if (this.persistOnStart) this.persistSession();
    } else if (command.type === "switch_session") {
      this.sessionFile = String(command.sessionPath);
      const header = JSON.parse(readFileSync(this.sessionFile, "utf8").trim()) as { id: string };
      this.sessionId = header.id;
    } else if (command.type === "set_session_name") {
      this.sessionName = String(command.name);
    }
    return success(
      String(command.type),
      command.type === "prompt" ? { disposition: this.disposition } : undefined,
    );
  }

  sessionState(): Record<string, unknown> {
    return {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      sessionName: this.sessionName,
    };
  }

  persistSession() {
    writeFileSync(
      this.sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: this.sessionId,
        timestamp: new Date().toISOString(),
        cwd: this.cwd,
      })}\n`,
    );
  }

  async getState() {
    return this.getStateHook?.() ?? this.sessionState();
  }

  settle() {
    this.emit("event", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    this.emit("event", { type: "agent_settled" });
  }

  sendRaw() {}

  async stop() {
    this.state = "stopped";
  }
}

function success(command: string, data?: unknown): PiRpcResponse {
  return { type: "response", command, success: true, data };
}

async function waitForIdle(service: PiThreadsService, worker: FakeWorker, count: number) {
  await vi.waitFor(() =>
    expect(
      service.events
        .eventsSince({ eventTypes: ["worker.idle"] })
        .filter((event) => event.workerId === worker.workerId),
    ).toHaveLength(count),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
