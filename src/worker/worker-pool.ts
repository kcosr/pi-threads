import { DaemonError } from "../errors.ts";
import type { EventBus } from "../service/event-bus.ts";
import { PiRpcWorker, type PiRpcResponse, type WorkerProcessState } from "./pi-rpc-worker.ts";

export interface WorkerPoolOptions {
  minWorkers: number;
  maxWorkers: number;
  idleTtlMs: number;
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
  lastUsedAt: Date;
  pid: number | undefined;
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
    await this.maintainMinimum();
    if (this.options.idleTtlMs > 0 || this.options.minWorkers > 0) {
      this.reaper = setInterval(
        () => void this.reapIdleWorkers(),
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
    return [...this.workers.values()].find((worker) => worker.threadId === threadId);
  }

  async acquireForNew(cwd: string): Promise<PooledWorker> {
    const idle = [...this.workers.values()].find(
      (worker) => worker.state === "idle" && worker.cwd === cwd && !worker.threadId,
    );
    return idle ?? this.spawn(cwd);
  }

  async acquireForSession(
    threadId: string,
    cwd: string,
    sessionPath: string,
  ): Promise<PooledWorker> {
    const assigned = this.findByThread(threadId);
    if (assigned) {
      if (assigned.state === "running") {
        throw new DaemonError("busy", "Thread already has an active daemon turn", { threadId });
      }
      return assigned;
    }
    const idle =
      [...this.workers.values()].find((worker) => worker.state === "idle" && worker.cwd === cwd) ??
      [...this.workers.values()].find((worker) => worker.state === "idle" && !worker.threadId);
    const worker = idle ?? (await this.spawn(cwd));
    if (worker.threadId !== threadId) {
      worker.state = "assigned";
      await worker.command({ type: "switch_session", sessionPath });
      worker.threadId = threadId;
    }
    return worker;
  }

  release(worker: PooledWorker, threadId?: string): void {
    worker.state = worker.threadId ? "assigned" : "idle";
    worker.lastUsedAt = new Date();
    this.events.emit({
      type: "worker.idle",
      workerId: worker.workerId,
      threadId: threadId ?? worker.threadId,
      payload: { cwd: worker.cwd },
    });
  }

  async stopAll(): Promise<void> {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
    await Promise.all([...this.workers.values()].map((worker) => worker.stop()));
    this.workers.clear();
  }

  private async spawn(cwd: string): Promise<PooledWorker> {
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
    worker.on("event", (event) => this.events.emit(mapWorkerEvent(worker, event)));
    worker.on("exit", (event) => {
      if (worker.state !== "crashed") {
        return;
      }
      this.workers.delete(worker.workerId);
      this.events.emit({
        type: "worker.crashed",
        workerId: worker.workerId,
        threadId: worker.threadId,
        payload: { pid: worker.pid, ...(event as Record<string, unknown>) },
      });
      void this.maintainMinimum().catch((error) => {
        this.events.emit({
          type: "worker.crashed",
          workerId: worker.workerId,
          threadId: worker.threadId,
          payload: {
            pid: worker.pid,
            recoveryFailed: true,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    });
    await worker.start();
    this.events.emit({
      type: "worker.started",
      workerId: worker.workerId,
      payload: { pid: worker.pid, version: worker.version, cwd },
    });
    return worker;
  }

  private async maintainMinimum(): Promise<void> {
    const target = Math.min(this.options.minWorkers, this.options.maxWorkers);
    while (this.workers.size < target) {
      await this.spawn(this.options.prewarmCwd ?? process.cwd());
    }
  }

  private async reapIdleWorkers(): Promise<void> {
    const now = Date.now();
    const candidates = [...this.workers.values()]
      .filter((worker) => worker.state === "idle" || worker.state === "assigned")
      .filter((worker) => now - worker.lastUsedAt.getTime() >= this.options.idleTtlMs)
      .sort((left, right) => left.lastUsedAt.getTime() - right.lastUsedAt.getTime());

    for (const worker of candidates) {
      if (this.workers.size <= this.options.minWorkers) {
        break;
      }
      this.workers.delete(worker.workerId);
      await worker.stop();
    }
    await this.maintainMinimum();
  }
}

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
    worker.state = "assigned";
    return {
      type: "turn.completed" as const,
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: { piEvent: raw, status: "completed" },
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
  if (type.includes("tool") || type.includes("bash")) {
    return {
      type: type.includes("start") ? ("tool.started" as const) : ("tool.completed" as const),
      workerId: worker.workerId,
      threadId: worker.threadId,
      turnId: worker.activeTurnId,
      payload: raw,
    };
  }
  if (type.includes("message")) {
    return {
      type: type.includes("complete") ? ("message.completed" as const) : ("message.delta" as const),
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
