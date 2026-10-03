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
    const replacement = await pool.acquireForNew("/tmp/project");
    expect(replacement).toBe(created[1]);
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

  it("keeps a worker with its thread and replaces it for another thread when reuse is disabled", async () => {
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 1,
        idleTtlMs: 300_000,
        reuseAcrossThreads: false,
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );
    const first = await pool.acquireForNew("/tmp/project");
    first.threadId = "thread-1";
    pool.release(first);
    const resumed = await pool.acquireForSession("thread-1", first.cwd, "/tmp/session-1");
    expect(resumed).toBe(first);
    pool.release(resumed);

    const second = await pool.acquireForSession("thread-2", first.cwd, "/tmp/session-2");
    expect(second.workerId).not.toBe(first.workerId);
    expect(first.state).toBe("stopped");
    expect(second.threadId).toBe("thread-2");
    pool.release(second);

    const resumedAgain = await pool.acquireForSession("thread-1", "/tmp/project", "/tmp/session-1");
    expect(resumedAgain.workerId).not.toBe(first.workerId);
    expect(resumedAgain.cwd).toBe("/tmp/project");
    expect(second.state).toBe("stopped");
    await pool.stopAll();
  });

  it("replaces a bound worker if the resumed session workspace differs from its launch cwd", async () => {
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 1,
        idleTtlMs: 0,
        reuseAcrossThreads: false,
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );
    const first = await pool.acquireForSession("thread-1", "/tmp/original", "/tmp/session-1");
    pool.release(first);
    const resumed = await pool.acquireForSession("thread-1", "/tmp/current", "/tmp/session-1");
    expect(resumed.workerId).not.toBe(first.workerId);
    expect(resumed.cwd).toBe("/tmp/current");
    expect(first.state).toBe("stopped");
    await pool.stopAll();
  });

  it("restores the minimum after a workspace replacement reuses an existing worker with TTL disabled", async () => {
    vi.useFakeTimers();
    const pool = new WorkerPool(
      {
        minWorkers: 2,
        maxWorkers: 2,
        idleTtlMs: 0,
        prewarmCwd: "/tmp/target",
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );
    try {
      await pool.start();
      const original = await pool.acquireForSession("thread-1", "/tmp/original", "/tmp/session-1");
      pool.release(original);
      const target = pool.list().find((worker) => worker.cwd === "/tmp/target")!;
      const replacement = await pool.acquireForSession("thread-1", "/tmp/target", "/tmp/session-1");
      expect(replacement.workerId).toBe(target.workerId);
      expect(original.state).toBe("stopped");
      expect(pool.list()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(pool.list()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(pool.list()).toHaveLength(2);
      expect(pool.list().every((worker) => worker.cwd === "/tmp/target")).toBe(true);
    } finally {
      await pool.stopAll();
      vi.useRealTimers();
    }
  });

  it("preserves an unpersisted thread instead of replacing its worker for a changed cwd", async () => {
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 1,
        idleTtlMs: 0,
        canReclaim: () => false,
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );
    const worker = await pool.acquireForSession("thread-1", "/tmp/original", "/tmp/session-1");
    pool.release(worker);
    await expect(
      pool.acquireForSession("thread-1", "/tmp/changed", "/tmp/session-1"),
    ).rejects.toMatchObject({
      code: "capacity",
      message: expect.stringContaining("not persisted"),
    });
    expect(pool.findByThread("thread-1")).toBe(worker);
    expect(worker.state).toBe("assigned");
    await pool.stopAll();
  });

  it.each([
    "unexpected-session",
    undefined,
  ])("rejects a resumed session with mismatched Pi identity %s", async (sessionId) => {
    const worker = new FakeWorker("worker-1", "/tmp/project");
    worker.getState = async () => ({ sessionId });
    const pool = new WorkerPool(
      { minWorkers: 0, maxWorkers: 1, idleTtlMs: 0, workerFactory: () => worker },
      new EventBus(),
    );
    await expect(
      pool.acquireForSession("thread-1", "/tmp/project", "/tmp/session-1"),
    ).rejects.toMatchObject({ code: "piRpcError", data: { threadId: "thread-1" } });
    expect(worker.state).toBe("stopped");
    expect(pool.findByThread("thread-1")).toBeUndefined();
    expect(pool.list()).toEqual([]);
    await pool.stopAll();
  });

  it("never recycles a claimed worker after a failed new-session operation when reuse is disabled", async () => {
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 1,
        idleTtlMs: 0,
        reuseAcrossThreads: false,
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );
    const first = await pool.acquireForNew("/tmp/project");
    pool.release(first);
    const next = await pool.acquireForNew("/tmp/project");
    expect(next.workerId).not.toBe(first.workerId);
    expect(first.state).toBe("stopped");
    await pool.stopAll();
  });

  it("reuses quiescent workers in the same cwd by default", async () => {
    const pool = new WorkerPool(
      { minWorkers: 0, maxWorkers: 1, idleTtlMs: 0, workerFactory: fakeWorkerFactory() },
      new EventBus(),
    );
    const first = await pool.acquireForSession("thread-1", "/tmp/project", "/tmp/session-1");
    pool.release(first);
    expect(await pool.acquireForSession("thread-2", "/tmp/project", "/tmp/session-2")).toBe(first);
    expect(first.threadId).toBe("thread-2");
    pool.release(first);
    expect(await pool.acquireForNew("/tmp/project")).toBe(first);
    expect(first.threadId).toBeUndefined();
    await pool.stopAll();
  });

  it.each([
    true,
    false,
  ])("launches resumed threads in their cwd with reuseAcrossThreads=%s", async (reuseAcrossThreads) => {
    const pool = new WorkerPool(
      {
        minWorkers: 1,
        maxWorkers: 1,
        idleTtlMs: 0,
        reuseAcrossThreads,
        prewarmCwd: "/tmp/default",
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );
    await pool.start();
    const prewarmed = pool.read(pool.list()[0]!.workerId);
    const resumed = await pool.acquireForSession("thread-1", "/tmp/project", "/tmp/session-1");
    expect(resumed.cwd).toBe("/tmp/project");
    expect(resumed.workerId).not.toBe(prewarmed.workerId);
    expect(prewarmed.state).toBe("stopped");
    await pool.stopAll();
  });

  it("evicts the least recently used idle worker at capacity even at the minimum", async () => {
    const pool = new WorkerPool(
      {
        minWorkers: 2,
        maxWorkers: 2,
        idleTtlMs: 0,
        prewarmCwd: "/tmp/default",
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );
    await pool.start();
    const [newer, older] = pool.list().map(({ workerId }) => pool.read(workerId));
    newer!.lastUsedAt = new Date(2_000);
    older!.lastUsedAt = new Date(1_000);
    const acquired = await pool.acquireForNew("/tmp/project");
    expect(older!.state).toBe("stopped");
    expect(newer!.state).toBe("idle");
    expect(acquired.cwd).toBe("/tmp/project");
    expect(pool.list()).toHaveLength(2);
    await pool.stopAll();
  });

  it("protects active turns, queued commands, and nested reservations from capacity eviction", async () => {
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 1,
        idleTtlMs: 0,
        reuseAcrossThreads: false,
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );
    const worker = (await pool.acquireForNew("/tmp/project")) as FakeWorker;
    await expect(pool.acquireForNew("/tmp/other")).rejects.toMatchObject({ code: "capacity" });
    pool.retain(worker);
    pool.release(worker);
    await expect(pool.acquireForNew("/tmp/other")).rejects.toMatchObject({ code: "capacity" });
    worker.activeTurnId = "turn-1";
    pool.release(worker);
    await expect(pool.acquireForNew("/tmp/other")).rejects.toMatchObject({ code: "capacity" });
    worker.activeTurnId = undefined;
    worker.pendingCommandCount = 2;
    await expect(pool.acquireForNew("/tmp/other")).rejects.toMatchObject({ code: "capacity" });
    worker.pendingCommandCount = 0;
    const next = await pool.acquireForNew("/tmp/other");
    expect(next.workerId).not.toBe(worker.workerId);
    await pool.stopAll();
  });

  it("does not assign a reserved thread to a second concurrent session operation", async () => {
    const pool = new WorkerPool(
      { minWorkers: 0, maxWorkers: 1, idleTtlMs: 0, workerFactory: fakeWorkerFactory() },
      new EventBus(),
    );
    const first = await pool.acquireForSession("thread-1", "/tmp/project", "/tmp/session-1");
    await expect(
      pool.acquireForSession("thread-1", "/tmp/project", "/tmp/session-1"),
    ).rejects.toMatchObject({ code: "busy" });
    pool.release(first);
    expect(await pool.acquireForSession("thread-1", "/tmp/project", "/tmp/session-1")).toBe(first);
    await pool.stopAll();
  });

  it.each([
    true,
    false,
  ])("preserves non-reclaimable threads at capacity with reuseAcrossThreads=%s", async (reuseAcrossThreads) => {
    let persisted = false;
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 1,
        idleTtlMs: 0,
        reuseAcrossThreads,
        canReclaim: () => persisted,
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );
    const first = await pool.acquireForSession("thread-1", "/tmp/project", "/tmp/session-1");
    pool.release(first);
    expect(await pool.acquireForSession("thread-1", "/tmp/project", "/tmp/session-1")).toBe(first);
    pool.release(first);
    await expect(pool.acquireForNew("/tmp/project")).rejects.toMatchObject({ code: "capacity" });
    await expect(
      pool.acquireForSession("thread-2", "/tmp/other", "/tmp/session-2"),
    ).rejects.toMatchObject({ code: "capacity" });
    expect(pool.findByThread("thread-1")).toBe(first);
    persisted = true;
    const next = await pool.acquireForNew("/tmp/project");
    expect(next === first).toBe(reuseAcrossThreads);
    await pool.stopAll();
  });

  it("retains non-reclaimable threads past TTL until their session can be restored", async () => {
    vi.useFakeTimers();
    let persisted = false;
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 1,
        idleTtlMs: 10,
        reapIntervalMs: 10,
        canReclaim: () => persisted,
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );
    try {
      await pool.start();
      const worker = await pool.acquireForSession("thread-1", "/tmp/project", "/tmp/session-1");
      pool.release(worker);
      await vi.advanceTimersByTimeAsync(100);
      expect(pool.findByThread("thread-1")).toBe(worker);
      persisted = true;
      await vi.advanceTimersByTimeAsync(10);
      expect(pool.list()).toEqual([]);
      expect(worker.state).toBe("stopped");
    } finally {
      await pool.stopAll();
      vi.useRealTimers();
    }
  });

  it("allows unbound prewarmed workers regardless of the reclaim predicate", async () => {
    const canReclaim = vi.fn(() => false);
    const pool = new WorkerPool(
      {
        minWorkers: 1,
        maxWorkers: 1,
        idleTtlMs: 0,
        prewarmCwd: "/tmp/default",
        canReclaim,
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );
    await pool.start();
    const worker = await pool.acquireForNew("/tmp/project");
    expect(worker.cwd).toBe("/tmp/project");
    expect(canReclaim).not.toHaveBeenCalled();
    await pool.stopAll();
  });

  it("detaches reused workers before a concurrent old-thread read can retain them", async () => {
    const pool = new WorkerPool(
      { minWorkers: 0, maxWorkers: 1, idleTtlMs: 0, workerFactory: fakeWorkerFactory() },
      new EventBus(),
    );
    const first = await pool.acquireForSession("thread-1", "/tmp/project", "/tmp/session-1");
    pool.release(first);
    const switching = pool.acquireForSession("thread-2", "/tmp/project", "/tmp/session-2");
    let readWorker: PooledWorker | undefined;
    // This continuation runs after worker selection but before its caller resumes.
    await Promise.resolve().then(() => {
      readWorker = pool.findByThread("thread-1");
      if (readWorker) pool.retain(readWorker);
    });
    const second = await switching;
    expect(readWorker).toBeUndefined();
    expect(second).toBe(first);
    expect(second.threadId).toBe("thread-2");
    pool.release(second);
    await pool.stopAll();
  });

  it("does not expose a target thread until its session switch completes", async () => {
    const pool = new WorkerPool(
      { minWorkers: 0, maxWorkers: 1, idleTtlMs: 0, workerFactory: fakeWorkerFactory() },
      new EventBus(),
    );
    const worker = await pool.acquireForSession("thread-1", "/tmp/project", "/tmp/session-1");
    pool.release(worker);
    const switching = deferred<void>();
    const switched = deferred<void>();
    worker.command = async (command) => {
      switching.resolve();
      await switched.promise;
      return { type: "response", command: String(command.type), success: true };
    };
    worker.getState = async () => ({ sessionId: "thread-2" });
    const acquiring = pool.acquireForSession("thread-2", "/tmp/project", "/tmp/session-2");
    await switching.promise;
    expect(pool.findByThread("thread-1")).toBeUndefined();
    expect(pool.findByThread("thread-2")).toBeUndefined();
    switched.resolve();
    expect(await acquiring).toBe(worker);
    expect(pool.findByThread("thread-2")).toBe(worker);
    pool.release(worker);
    await pool.stopAll();
  });

  it("reserves capacity until an evicted process stops during concurrent acquisitions", async () => {
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 1,
        idleTtlMs: 0,
        reuseAcrossThreads: false,
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );
    const old = (await pool.acquireForNew("/tmp/first")) as FakeWorker;
    pool.release(old);
    const stopping = deferred<void>();
    const stopped = deferred<void>();
    const originalStop = old.stop.bind(old);
    old.stop = async () => {
      stopping.resolve();
      await stopped.promise;
      await originalStop();
    };
    const next = pool.acquireForNew("/tmp/second");
    await stopping.promise;
    const concurrent = pool.acquireForNew("/tmp/third");
    expect(pool.list()).toHaveLength(1);
    expect(() => pool.retain(old)).toThrow("no longer available");
    stopped.resolve();
    expect((await next).cwd).toBe("/tmp/second");
    await expect(concurrent).rejects.toMatchObject({ code: "capacity" });
    expect(pool.list()).toHaveLength(1);
    await pool.stopAll();
  });

  it("protects newly starting workers and shuts down cleanly during startup", async () => {
    const starting = deferred<void>();
    const started = deferred<void>();
    const workers: FakeWorker[] = [];
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 1,
        idleTtlMs: 0,
        workerFactory: ({ workerId, cwd }) => {
          const worker = new FakeWorker(workerId, cwd);
          worker.start = async () => {
            starting.resolve();
            await started.promise;
            worker.state = "idle";
          };
          workers.push(worker);
          return worker;
        },
      },
      new EventBus(),
    );
    const acquiring = pool.acquireForNew("/tmp/project");
    await starting.promise;
    const stopping = pool.stopAll();
    started.resolve();
    await expect(acquiring).rejects.toThrow("stopped during worker startup");
    await stopping;
    expect(workers).toHaveLength(1);
    expect(workers[0]!.state).toBe("stopped");
    expect(pool.list()).toEqual([]);
  });

  it("disables timeout eviction when idleTtlMs is zero even with prewarming", async () => {
    vi.useFakeTimers();
    const pool = new WorkerPool(
      {
        minWorkers: 1,
        maxWorkers: 2,
        idleTtlMs: 0,
        reapIntervalMs: 10,
        prewarmCwd: "/tmp/default",
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );
    try {
      await pool.start();
      const extra = await pool.acquireForNew("/tmp/project");
      pool.release(extra);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pool.list()).toHaveLength(2);
    } finally {
      await pool.stopAll();
      vi.useRealTimers();
    }
  });

  it.each([
    "reservation",
    "persistence",
  ])("rechecks timeout candidates' %s after awaiting shutdown", async (protection) => {
    vi.useFakeTimers();
    let persisted = true;
    const pool = new WorkerPool(
      {
        minWorkers: 0,
        maxWorkers: 2,
        idleTtlMs: 10,
        reapIntervalMs: 10,
        canReclaim: () => persisted,
        workerFactory: fakeWorkerFactory(),
      },
      new EventBus(),
    );
    const first = (await pool.acquireForNew("/tmp/first")) as FakeWorker;
    const second = await pool.acquireForNew("/tmp/second");
    second.threadId = "thread-2";
    pool.release(first);
    pool.release(second);
    const stopped = deferred<void>();
    const stopping = deferred<void>();
    const originalStop = first.stop.bind(first);
    first.stop = async () => {
      stopping.resolve();
      await stopped.promise;
      await originalStop();
    };
    try {
      await pool.start();
      await vi.advanceTimersByTimeAsync(10);
      await stopping.promise;
      if (protection === "reservation") pool.retain(second);
      else persisted = false;
      stopped.resolve();
      await vi.advanceTimersByTimeAsync(10);
      expect(pool.list().map(({ workerId }) => workerId)).toEqual([second.workerId]);
      if (protection === "reservation") pool.release(second);
      else persisted = true;
      await vi.advanceTimersByTimeAsync(20);
      expect(pool.list()).toEqual([]);
    } finally {
      stopped.resolve();
      await pool.stopAll();
      vi.useRealTimers();
    }
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
  pendingCommandCount = 0;
  sessionId = "thread-1";
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
      const sessions: Record<string, string> = {
        "/tmp/session-1": "thread-1",
        "/tmp/session-2": "thread-2",
        "/tmp/project/session": "thread-1",
      };
      this.sessionId = sessions[String(command.sessionPath)] ?? "unexpected-session";
    }
    return { type: "response" as const, command: String(command.type), success: true };
  }

  async getState(): Promise<Record<string, unknown>> {
    return { sessionId: this.sessionId };
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
