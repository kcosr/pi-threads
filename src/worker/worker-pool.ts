import { DaemonError } from "../errors.ts";
import type { EventBus } from "../service/event-bus.ts";
import { PiRpcWorker, type PiRpcResponse, type WorkerProcessState } from "./pi-rpc-worker.ts";

export interface WorkerPoolOptions {
  minWorkers: number;
  maxWorkers: number;
  idleTtlMs: number;
  reuseAcrossThreads?: boolean;
  canReclaim?: (worker: PooledWorker) => boolean;
  piBin?: string;
  prewarmCwd?: string;
  reapIntervalMs?: number;
  workerFactory?: (options: { workerId: string; cwd: string; piBin?: string }) => PooledWorker;
}

export interface PooledWorker {
  readonly workerId: string;
  readonly cwd: string;
  readonly startedAt: Date;
  version: string | undefined;
  state: WorkerProcessState;
  threadId: string | undefined;
  activeTurnId: string | undefined;
  abortingTurnId?: string;
  lastUsedAt: Date;
  pid: number | undefined;
  readonly pendingCommandCount?: number;
  start(): Promise<void>;
  command(command: Record<string, unknown>, timeoutMs?: number): Promise<PiRpcResponse>;
  getState(): Promise<Record<string, unknown>>;
  sendRaw(value: unknown): void;
  stop(timeoutMs?: number): Promise<void>;
  on(event: string, listener: (event: unknown) => void): unknown;
}

export class WorkerPool {
  private readonly workers = new Map<string, PooledWorker>();
  private readonly workerFactory: NonNullable<WorkerPoolOptions["workerFactory"]>;
  private reaper: NodeJS.Timeout | undefined;
  private nextWorkerId = 1;
  private stopped = false;
  private recoveryTimer: NodeJS.Timeout | undefined;
  private recoveryDelayMs = 1_000;
  private lifecycle: Promise<void> = Promise.resolve();
  private readonly reservations = new WeakMap<PooledWorker, number>();
  private readonly claimed = new WeakSet<PooledWorker>();
  private readonly retiring = new WeakSet<PooledWorker>();

  constructor(
    private readonly options: WorkerPoolOptions,
    private readonly events: EventBus,
  ) {
    this.workerFactory =
      options.workerFactory ??
      ((workerOptions) =>
        new PiRpcWorker({
          workerId: workerOptions.workerId,
          cwd: workerOptions.cwd,
          piBin: workerOptions.piBin,
        }));
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.withLifecycle(() => this.maintainMinimum());
    if (this.options.idleTtlMs > 0 || this.options.minWorkers > 0) {
      this.reaper = setInterval(
        () => {
          void this.withLifecycle(() => this.reapIdleWorkers()).catch((error) => {
            this.events.emit({
              type: "worker.crashed",
              payload: { message: error instanceof Error ? error.message : String(error) },
            });
          });
        },
        this.options.reapIntervalMs ??
          Math.min(Math.max(this.options.idleTtlMs / 2, 1_000), 60_000),
      );
      this.reaper.unref?.();
    }
  }

  list() {
    return [...this.workers.values()].map((worker) => ({
      workerId: worker.workerId,
      pid: worker.pid,
      cwd: worker.cwd,
      state: worker.state,
      threadId: worker.threadId,
      version: worker.version,
      startedAt: worker.startedAt.toISOString(),
      lastUsedAt: worker.lastUsedAt.toISOString(),
    }));
  }

  read(workerId: string): PooledWorker {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new DaemonError("notFound", "Worker not found", { workerId });
    }
    return worker;
  }

  findByThread(threadId: string): PooledWorker | undefined {
    return [...this.workers.values()].find(
      (worker) =>
        worker.threadId === threadId && !this.retiring.has(worker) && !isUnavailableWorker(worker),
    );
  }

  async acquireForNew(cwd: string): Promise<PooledWorker> {
    return this.withLifecycle(async () => {
      this.assertRunning();
      return this.selectWorker(cwd);
    });
  }

  async acquireForSession(
    threadId: string,
    cwd: string,
    sessionPath: string,
  ): Promise<PooledWorker> {
    return this.withLifecycle(async () => {
      this.assertRunning();
      const assigned = this.findByThread(threadId);
      if (assigned) {
        if (!this.isQuiescent(assigned)) {
          throw new DaemonError("busy", "Thread already has an active daemon operation", {
            threadId,
          });
        }
        if (assigned.cwd === cwd) {
          this.retain(assigned);
          return assigned;
        }
        if (!this.isReclaimable(assigned)) {
          throw new DaemonError(
            "capacity",
            "Thread session is not persisted; cannot replace its worker for another workspace",
            {
              threadId,
            },
          );
        }
        await this.retire(assigned);
        this.scheduleMinimumRecovery();
      }
      const worker = await this.selectWorker(cwd);
      try {
        const response = await worker.command({ type: "switch_session", sessionPath });
        assertNotCancelled(response, "switch_session");
        const state = await worker.getState();
        if (state.sessionId !== threadId) {
          throw new DaemonError("piRpcError", "Pi resumed a different session than requested", {
            threadId,
            sessionId: state.sessionId,
            sessionPath,
          });
        }
        worker.threadId = threadId;
      } catch (error) {
        // A failed switch may have partially changed Pi's session. Never reuse it.
        this.release(worker);
        if (!isUnavailableWorker(worker)) {
          await this.retire(worker);
          this.scheduleMinimumRecovery();
        }
        throw error;
      }
      return worker;
    });
  }

  retain(worker: PooledWorker): void {
    this.assertRunning();
    if (
      this.workers.get(worker.workerId) !== worker ||
      this.retiring.has(worker) ||
      isUnavailableWorker(worker)
    ) {
      throw new DaemonError("workerCrashed", "Worker is no longer available", {
        workerId: worker.workerId,
      });
    }
    this.reservations.set(worker, (this.reservations.get(worker) ?? 0) + 1);
  }

  release(worker: PooledWorker, threadId?: string): void {
    const remaining = Math.max((this.reservations.get(worker) ?? 0) - 1, 0);
    this.reservations.set(worker, remaining);
    if (isUnavailableWorker(worker) || this.retiring.has(worker)) {
      return;
    }
    worker.lastUsedAt = new Date();
    if (remaining > 0 || worker.activeTurnId) {
      return;
    }
    worker.state = worker.threadId ? "assigned" : "idle";
    this.events.emit({
      type: "worker.idle",
      workerId: worker.workerId,
      threadId: threadId ?? worker.threadId,
      payload: { cwd: worker.cwd },
    });
  }

  private isQuiescent(worker: PooledWorker): boolean {
    return (
      (worker.state === "idle" || worker.state === "assigned") &&
      !worker.activeTurnId &&
      !worker.abortingTurnId &&
      !this.retiring.has(worker) &&
      (this.reservations.get(worker) ?? 0) === 0 &&
      (worker.pendingCommandCount ?? 0) === 0
    );
  }

  private isReclaimable(worker: PooledWorker): boolean {
    return (
      this.isQuiescent(worker) && (!worker.threadId || this.options.canReclaim?.(worker) !== false)
    );
  }

  private async selectWorker(cwd: string): Promise<PooledWorker> {
    const candidates = [...this.workers.values()].filter(
      (worker) =>
        this.isReclaimable(worker) &&
        (this.options.reuseAcrossThreads !== false || !this.claimed.has(worker)),
    );
    const idle = candidates.find((worker) => worker.cwd === cwd);
    if (idle) {
      // Detach the previous thread before yielding so direct thread reads cannot
      // retain this worker while its session is being replaced.
      this.reserveForAssignment(idle);
      idle.state = "assigned";
      return idle;
    }
    if (this.workers.size >= this.options.maxWorkers) {
      const victim = [...this.workers.values()]
        .filter((worker) => this.isReclaimable(worker))
        .sort((left, right) => left.lastUsedAt.getTime() - right.lastUsedAt.getTime())[0];
      if (!victim) {
        throw new DaemonError("capacity", "Worker capacity reached", {
          maxWorkers: this.options.maxWorkers,
        });
      }
      await this.retire(victim);
    }
    try {
      return await this.spawn(cwd, true);
    } catch (error) {
      this.scheduleMinimumRecovery();
      throw error;
    }
  }

  private reserveForAssignment(worker: PooledWorker): void {
    this.retain(worker);
    this.claimed.add(worker);
    worker.threadId = undefined;
  }

  private async retire(worker: PooledWorker): Promise<void> {
    this.retiring.add(worker);
    await worker.stop();
    this.workers.delete(worker.workerId);
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new DaemonError("workerCrashed", "Worker pool is stopped");
    }
  }

  private withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async stopAll(): Promise<void> {
    this.stopped = true;
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await this.withLifecycle(async () => {
      await Promise.all([...this.workers.values()].map((worker) => worker.stop()));
      this.workers.clear();
    });
  }

  private async spawn(cwd: string, reserve = false): Promise<PooledWorker> {
    if (this.stopped) {
      throw new DaemonError("workerCrashed", "Worker pool is stopped");
    }
    if (this.workers.size >= this.options.maxWorkers) {
      throw new DaemonError("capacity", "Worker capacity reached", {
        maxWorkers: this.options.maxWorkers,
      });
    }
    const worker = this.workerFactory({
      workerId: `worker_${this.nextWorkerId++}`,
      cwd,
      piBin: this.options.piBin,
    });
    this.workers.set(worker.workerId, worker);
    if (reserve) {
      this.reserveForAssignment(worker);
    }
    worker.on("event", (event) => this.events.emit(mapWorkerEvent(worker, event)));
    worker.on("exit", (event) => {
      if (worker.state !== "crashed") {
        return;
      }
      this.workers.delete(worker.workerId);
      const turnId = worker.activeTurnId;
      worker.activeTurnId = undefined;
      this.events.emit({
        type: "worker.crashed",
        workerId: worker.workerId,
        threadId: worker.threadId,
        turnId,
        payload: { pid: worker.pid, ...(event as Record<string, unknown>) },
      });
      if (turnId) {
        this.events.emit({
          type: "turn.failed",
          workerId: worker.workerId,
          threadId: worker.threadId,
          turnId,
          payload: { errorCode: "workerCrashed", message: "Pi RPC worker exited" },
        });
      }
      if (Date.now() - worker.startedAt.getTime() >= 60_000) {
        this.recoveryDelayMs = 1_000;
      }
      this.scheduleMinimumRecovery();
    });
    try {
      await worker.start();
      if (this.stopped) {
        throw new DaemonError("workerCrashed", "Worker pool stopped during worker startup");
      }
    } catch (error) {
      this.workers.delete(worker.workerId);
      await worker.stop().catch(() => undefined);
      throw error;
    }
    if (reserve) {
      worker.state = "assigned";
    }
    this.events.emit({
      type: "worker.started",
      workerId: worker.workerId,
      payload: { pid: worker.pid, version: worker.version, cwd },
    });
    return worker;
  }

  private async maintainMinimum(): Promise<void> {
    const target = Math.min(this.options.minWorkers, this.options.maxWorkers);
    while (!this.stopped && !this.recoveryTimer && this.workers.size < target) {
      await this.spawn(this.options.prewarmCwd ?? process.cwd());
    }
  }

  private scheduleMinimumRecovery(): void {
    const target = Math.min(this.options.minWorkers, this.options.maxWorkers);
    if (this.stopped || this.recoveryTimer || this.workers.size >= target) {
      return;
    }
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.withLifecycle(() => this.maintainMinimum()).catch((error) => {
        this.events.emit({
          type: "worker.crashed",
          payload: {
            recoveryFailed: true,
            message: error instanceof Error ? error.message : String(error),
          },
        });
        this.scheduleMinimumRecovery();
      });
    }, this.recoveryDelayMs);
    this.recoveryTimer.unref?.();
    this.recoveryDelayMs = Math.min(this.recoveryDelayMs * 2, 30_000);
  }

  private async reapIdleWorkers(): Promise<void> {
    if (this.stopped || this.options.idleTtlMs === 0) {
      return;
    }
    const now = Date.now();
    const candidates = [...this.workers.values()]
      .filter((worker) => this.isReclaimable(worker))
      .filter((worker) => now - worker.lastUsedAt.getTime() >= this.options.idleTtlMs)
      .sort((left, right) => left.lastUsedAt.getTime() - right.lastUsedAt.getTime());

    for (const worker of candidates) {
      if (this.workers.size <= this.options.minWorkers) {
        break;
      }
      if (this.isReclaimable(worker)) {
        await this.retire(worker);
      }
    }
    this.scheduleMinimumRecovery();
  }
}

const pendingSettledOutcomes = new WeakMap<
  PooledWorker,
  {
    turnId: string | undefined;
    piEvent: Record<string, unknown>;
    failure?: ReturnType<typeof agentFailure>;
  }
>();

function mapWorkerEvent(worker: PooledWorker, event: unknown) {
  const raw = event as Record<string, unknown>;
  const type = String(raw.type ?? "");
  if (type === "agent_start") {
    worker.state = "running";
    return {
      type: "turn.started" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: { piEvent: raw, piRunId: raw.id },
    };
  }
  if (type === "turn_start") {
    return {
      type: "run.step.started" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: { piEvent: raw },
    };
  }
  if (type === "turn_end") {
    return {
      type: "run.step.completed" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: { piEvent: raw },
    };
  }
  if (type === "agent_end") {
    const failure = agentFailure(raw);
    pendingSettledOutcomes.set(worker, { turnId: worker.activeTurnId, piEvent: raw, failure });
    return {
      type: "thread.updated" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: { piEvent: raw, status: raw.willRetry === true ? "retrying" : "settling" },
    };
  }
  if (type === "agent_settled") {
    worker.state = "assigned";
    const pending = pendingSettledOutcomes.get(worker);
    const outcome = pending?.turnId === worker.activeTurnId ? pending : undefined;
    pendingSettledOutcomes.delete(worker);
    if (!worker.activeTurnId) {
      return {
        type: "thread.updated" as const,
        workerId: worker.workerId,
        threadId: worker.threadId,
        payload: { piEvent: raw, status: "idle" },
      };
    }
    if (worker.abortingTurnId === worker.activeTurnId) {
      worker.abortingTurnId = undefined;
      return {
        type: "turn.aborted" as const,
        workerId: worker.workerId,
        threadId: worker.threadId,
        turnId: worker.activeTurnId,
        payload: { piEvent: raw, reason: "client", finalState: "aborted" },
      };
    }
    if (outcome?.failure) {
      return {
        type: "turn.failed" as const,
        workerId: worker.workerId,
        threadId: worker.threadId,
        turnId: worker.activeTurnId,
        payload: {
          piEvent: outcome.piEvent,
          settledPiEvent: raw,
          status: "failed",
          ...outcome.failure,
        },
      };
    }
    return {
      type: "turn.completed" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: {
        piEvent: raw,
        ...(outcome ? { agentEndPiEvent: outcome.piEvent } : {}),
        status: "completed",
      },
    };
  }
  if (type === "auto_retry_start") {
    return {
      type: "retry.scheduled" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: raw,
    };
  }
  if (type === "queue_update") {
    return {
      type: "queue.updated" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: raw,
    };
  }
  if (type === "auto_retry_end") {
    return {
      type: "retry.completed" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: raw,
    };
  }
  if (type === "compaction_start") {
    return {
      type: "compaction.started" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: raw,
    };
  }
  if (type === "compaction_end") {
    return {
      type: "compaction.completed" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: raw,
    };
  }
  if (type === "extension_ui_request") {
    return {
      type: "extension_ui.requested" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: raw,
    };
  }
  if (type === "extension_error") {
    return {
      type: "extension.error" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: raw,
    };
  }
  if (type === "tool_execution_start") {
    return {
      type: "tool.started" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: raw,
    };
  }
  if (type === "tool_execution_update" || type === "tool_execution_end") {
    return {
      type:
        type === "tool_execution_update" ? ("tool.updated" as const) : ("tool.completed" as const),
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: raw,
    };
  }
  if (type === "message_start" || type === "message_update") {
    return {
      type: "message.delta" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: raw,
    };
  }
  if (type === "message_end") {
    return {
      type: "message.completed" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: raw,
    };
  }
  return {
    type: "thread.updated" as const,
    workerId: worker.workerId,
    threadId: worker.threadId,
    turnId: worker.activeTurnId,
    payload: { piEvent: raw },
  };
}

function isUnavailableWorker(worker: PooledWorker): boolean {
  return worker.state === "crashed" || worker.state === "stopped";
}

function assertNotCancelled(response: PiRpcResponse, command: string): void {
  if (
    response.data &&
    typeof response.data === "object" &&
    (response.data as Record<string, unknown>).cancelled === true
  ) {
    throw new DaemonError("piRpcError", "Pi RPC command was cancelled", { command });
  }
}

function agentFailure(
  raw: Record<string, unknown>,
): { errorCode: "piRpcError"; message: string; stopReason?: string } | undefined {
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const failed = messages
    .map((message) => (message && typeof message === "object" ? message : undefined))
    .filter((message): message is Record<string, unknown> => Boolean(message))
    .find((message) => {
      const stopReason = message.stopReason;
      return stopReason === "error" || stopReason === "aborted";
    });
  if (!failed) {
    return undefined;
  }
  const stopReason = typeof failed.stopReason === "string" ? failed.stopReason : undefined;
  const message =
    typeof failed.errorMessage === "string"
      ? failed.errorMessage
      : `Pi turn ended with stopReason ${stopReason ?? "unknown"}`;
  return { errorCode: "piRpcError", message, stopReason };
}
