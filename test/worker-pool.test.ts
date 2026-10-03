import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/service/event-bus.ts";
import type { DaemonEvent } from "../src/protocol/events.ts";
import { WorkerPool, type PooledWorker } from "../src/worker/worker-pool.ts";

describe("WorkerPool lifecycle", () => {
  it("returns capacity after worker startup fails", async () => {
    const created: FakeWorker[] = [];
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 1,
        idleTtlMs: 300_000,
        workerFactory: ({ workerId, cwd }) => {
          const worker = new FakeWorker(workerId, cwd);
          if (created.length === 0) {
            worker.start = vi.fn().mockRejectedValue(new Error("unsupported version"));
          }
          created.push(worker);
          return worker;
        },
      },
      new EventBus(),
    );

    await expect(pool.acquireForNew("/tmp/project")).rejects.toThrow("unsupported version");
    expect(pool.list()).toEqual([]);
    expect(created[0]!.state).toBe("stopped");
    await expect(pool.acquireForNew("/tmp/project")).resolves.toBe(created[1]);
    await pool.stopAll();
  });

  it("prewarms to minWorkers", async () => {
    const pool = new WorkerPool(
      {
        minWorkers: 1,
        maxWorkers: 2,
        idleTtlMs: 300_000,
        prewarmCwd: "/tmp/prewarm",
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );

    await pool.start();

    expect(pool.list()).toMatchObject([{ cwd: "/tmp/prewarm", state: "idle" }]);
    await pool.stopAll();
  });

  it("does not start replacement workers after shutdown", async () => {
    const pool = new WorkerPool(
      { minWorkers: 0, maxWorkers: 1, idleTtlMs: 300_000, workerFactory: fakeWorkerFactory() },
      new EventBus(),
    );
    await pool.stopAll();
    await expect(pool.acquireForNew("/tmp/project")).rejects.toThrow("Worker pool is stopped");
    expect(pool.list()).toEqual([]);
  });

  it("reaps idle workers down to minWorkers", async () => {
    const pool = new WorkerPool(
      {
        minWorkers: 1,
        maxWorkers: 3,
        idleTtlMs: 20,
        reapIntervalMs: 10,
        prewarmCwd: "/tmp/prewarm",
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );

    await pool.start();
    const extra = await pool.acquireForNew("/tmp/other");
    pool.release(extra);

    await eventually(() => expect(pool.list()).toHaveLength(1));
    expect(pool.list()[0]?.state).toBe("idle");
    await pool.stopAll();
  });

  it("backs off repeated crashes while restoring minWorkers and cancels recovery on shutdown", async () => {
    vi.useFakeTimers();
    const created: FakeWorker[] = [];
    const pool = new WorkerPool(
      {
        minWorkers: 1,
        maxWorkers: 2,
        idleTtlMs: 300_000,
        prewarmCwd: "/tmp/prewarm",
        workerFactory: ({ workerId, cwd }) => {
          const worker = new FakeWorker(workerId, cwd);
          created.push(worker);
          return worker;
        },
      },
      new EventBus(),
    );

    try {
      await pool.start();
      created[0]!.crash();
      expect(pool.list()).toEqual([]);
      await vi.advanceTimersByTimeAsync(999);
      expect(created).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(pool.list()).toHaveLength(1);
      created[1]!.crash();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(created).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(created).toHaveLength(3);
      created[2]!.crash();
      await pool.stopAll();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(created).toHaveLength(3);
    } finally {
      await pool.stopAll();
      vi.useRealTimers();
    }
  });

  it("reserves a worker while switching sessions", async () => {
    const created: FakeWorker[] = [];
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 2,
        idleTtlMs: 300_000,
        workerFactory: ({ workerId, cwd }) => {
          const worker = new FakeWorker(workerId, cwd);
          worker.switchDelayMs = 50;
          created.push(worker);
          return worker;
        },
      },
      new EventBus(),
    );

    await pool.start();
    const switching = pool.acquireForSession("thread-1", "/tmp/project", "/tmp/project/session");
    await eventually(() => expect(created[0]?.state).toBe("assigned"));
    const newWorker = await pool.acquireForNew("/tmp/project");

    expect(newWorker.workerId).not.toBe(created[0]!.workerId);
    await switching;
    await pool.stopAll();
  });

  it("preserves a crashed worker state after a failed session switch", async () => {
    const worker = new FakeWorker("worker-1", "/tmp/project");
    worker.command = async () => {
      worker.state = "crashed";
      throw new Error("command timeout");
    };
    const pool = new WorkerPool(
      { minWorkers: 0, maxWorkers: 1, idleTtlMs: 300_000, workerFactory: () => worker },
      new EventBus(),
    );
    await expect(
      pool.acquireForSession("thread-1", worker.cwd, "/tmp/session.jsonl"),
    ).rejects.toThrow("command timeout");
    expect(worker.state).toBe("crashed");
    await pool.stopAll();
  });

  it("reserves workers atomically for concurrent new sessions", async () => {
    const pool = new WorkerPool(
      {
        minWorkers: 1,
        maxWorkers: 2,
        idleTtlMs: 300_000,
        prewarmCwd: "/tmp/project",
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );

    await pool.start();
    const [left, right] = await Promise.all([
      pool.acquireForNew("/tmp/project"),
      pool.acquireForNew("/tmp/project"),
    ]);

    expect(left.workerId).not.toBe(right.workerId);
    expect(pool.list().map((worker) => worker.state)).toEqual(["assigned", "assigned"]);
    await pool.stopAll();
  });

  it("does not complete a turn on retrying agent_end", async () => {
    const events = new EventBus();
    const observed: DaemonEvent[] = [];
    events.subscribe({}, (event) => observed.push(event));
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 1,
        idleTtlMs: 300_000,
        workerFactory: fakeWorkerFactory(),
      },
      events,
    );

    const worker = await pool.acquireForNew("/tmp/project");
    worker.threadId = "thread-1";
    worker.activeTurnId = "turn-1";
    worker.state = "running";
    (worker as FakeWorker).emitEvent({
      type: "agent_end",
      willRetry: true,
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "retry me" }],
    });
    (worker as FakeWorker).emitEvent({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1,
      errorMessage: "retry me",
    });

    expect(observed.map((event) => event.type)).not.toContain("turn.completed");
    expect(observed.map((event) => event.type)).toContain("retry.scheduled");
    expect(worker.state).toBe("running");
    await pool.stopAll();
  });

  it("maps real Pi terminal message and failed agent events", async () => {
    const events = new EventBus();
    const observed: DaemonEvent[] = [];
    events.subscribe({}, (event) => observed.push(event));
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 1,
        idleTtlMs: 300_000,
        workerFactory: fakeWorkerFactory(),
      },
      events,
    );

    const worker = await pool.acquireForNew("/tmp/project");
    worker.threadId = "thread-1";
    worker.activeTurnId = "turn-1";
    worker.state = "running";
    (worker as FakeWorker).emitEvent({ type: "message_end", message: { role: "assistant" } });
    (worker as FakeWorker).emitEvent({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "failed" }],
    });

    (worker as FakeWorker).emitEvent({ type: "agent_settled" });

    expect(observed.map((event) => event.type)).toContain("message.completed");
    expect(observed.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { message: "failed", stopReason: "error" },
    });
    await pool.stopAll();
  });

  it("waits for agent_settled before completing Pi 1.0 turns", async () => {
    const events = new EventBus();
    const observed: DaemonEvent[] = [];
    events.subscribe({}, (event) => observed.push(event));
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 1,
        idleTtlMs: 300_000,
        workerFactory: fakeWorkerFactory("1.0.0"),
      },
      events,
    );

    const worker = await pool.acquireForNew("/tmp/project");
    worker.threadId = "thread-1";
    worker.activeTurnId = "turn-1";
    worker.state = "running";
    (worker as FakeWorker).emitEvent({
      type: "agent_end",
      willRetry: true,
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "retry me" }],
    });
    (worker as FakeWorker).emitEvent({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "stop" }],
    });

    expect(observed.map((event) => event.type)).not.toContain("turn.completed");
    expect(worker.state).toBe("running");

    (worker as FakeWorker).emitEvent({ type: "agent_settled" });

    expect(observed.at(-1)?.type).toBe("turn.completed");
    expect(worker.state).toBe("assigned");
    await pool.stopAll();
  });

  it("defers Pi 1.0 failures until agent_settled", async () => {
    const events = new EventBus();
    const observed: DaemonEvent[] = [];
    events.subscribe({}, (event) => observed.push(event));
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 1,
        idleTtlMs: 300_000,
        workerFactory: fakeWorkerFactory("1.0.0"),
      },
      events,
    );

    const worker = await pool.acquireForNew("/tmp/project");
    worker.threadId = "thread-1";
    worker.activeTurnId = "turn-1";
    worker.state = "running";
    (worker as FakeWorker).emitEvent({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "failed" }],
    });

    expect(observed.map((event) => event.type)).not.toContain("turn.failed");

    (worker as FakeWorker).emitEvent({ type: "agent_settled" });

    expect(observed.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { message: "failed", stopReason: "error" },
    });
    await pool.stopAll();
  });

  it("does not reuse another turn's unsettled failure", async () => {
    const events = new EventBus();
    const pool = new WorkerPool(
      { minWorkers: 0, maxWorkers: 1, idleTtlMs: 300_000, workerFactory: fakeWorkerFactory() },
      events,
    );
    const worker = (await pool.acquireForNew("/tmp/project")) as FakeWorker;
    worker.threadId = "thread-1";
    worker.activeTurnId = "turn-1";
    worker.emitEvent({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error" }] });
    worker.activeTurnId = "turn-2";
    worker.emitEvent({ type: "agent_settled" });

    expect(events.eventsSince({}).at(-1)).toMatchObject({
      type: "turn.completed",
      turnId: "turn-2",
    });
    await pool.stopAll();
  });

  it("publishes actual queue contents, including queue drain", async () => {
    const events = new EventBus();
    const pool = new WorkerPool(
      { minWorkers: 0, maxWorkers: 1, idleTtlMs: 300_000, workerFactory: fakeWorkerFactory() },
      events,
    );
    const worker = (await pool.acquireForNew("/tmp/project")) as FakeWorker;
    worker.emitEvent({ type: "queue_update", steering: ["change course"], followUp: [] });
    worker.emitEvent({ type: "queue_update", steering: [], followUp: [] });

    expect(
      events.eventsSince({ eventTypes: ["queue.updated"] }).map((event) => event.payload),
    ).toEqual([
      { type: "queue_update", steering: ["change course"], followUp: [] },
      { type: "queue_update", steering: [], followUp: [] },
    ]);
    await pool.stopAll();
  });

  it("distinguishes partial tool output from completed tool calls", async () => {
    const events = new EventBus();
    const pool = new WorkerPool(
      { minWorkers: 0, maxWorkers: 1, idleTtlMs: 300_000, workerFactory: fakeWorkerFactory() },
      events,
    );
    const worker = (await pool.acquireForNew("/tmp/project")) as FakeWorker;
    worker.emitEvent({ type: "tool_execution_start", toolCallId: "tool-1" });
    worker.emitEvent({ type: "tool_execution_update", toolCallId: "tool-1", partialResult: {} });
    worker.emitEvent({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      result: {},
      isError: false,
    });
    expect(
      events
        .eventsSince({ eventTypes: ["tool.started", "tool.updated", "tool.completed"] })
        .map((event) => event.type),
    ).toEqual(["tool.started", "tool.updated", "tool.completed"]);
    await pool.stopAll();
  });
});

function fakeWorkerFactory(
  version = "1.0.0",
): NonNullable<ConstructorParameters<typeof WorkerPool>[0]["workerFactory"]> {
  return ({ workerId, cwd }) => new FakeWorker(workerId, cwd, version);
}

class FakeWorker {
  readonly startedAt = new Date();
  version: string;
  state: PooledWorker["state"] = "starting";
  threadId: string | undefined;
  activeTurnId: string | undefined;
  lastUsedAt = new Date();
  pid = 1234;
  switchDelayMs = 0;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(
    readonly workerId: string,
    readonly cwd: string,
    version = "1.0.0",
  ) {
    this.version = version;
  }

  async start(): Promise<void> {
    this.state = "idle";
  }

  async command(command: Record<string, unknown>) {
    this.lastUsedAt = new Date();
    if (command.type === "switch_session") {
      if (this.switchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.switchDelayMs));
      }
    }
    return { type: "response" as const, command: String(command.type), success: true };
  }

  async getState(): Promise<Record<string, unknown>> {
    return {};
  }

  sendRaw(): void {}

  async stop(): Promise<void> {
    this.state = "stopped";
    for (const listener of this.listeners.get("exit") ?? []) {
      listener({ exitCode: 0, signal: null });
    }
  }

  crash(): void {
    this.state = "crashed";
    for (const listener of this.listeners.get("exit") ?? []) {
      listener({ exitCode: 1, signal: null });
    }
  }

  emitEvent(event: unknown): void {
    for (const listener of this.listeners.get("event") ?? []) {
      listener(event);
    }
  }

  on(event: string, listener: (event: unknown) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}
