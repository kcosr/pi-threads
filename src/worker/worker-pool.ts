import { DaemonError } from "../errors.ts";
import type { EventBus } from "../service/event-bus.ts";
import { PiRpcWorker } from "./pi-rpc-worker.ts";

export interface WorkerPoolOptions {
  minWorkers: number;
  maxWorkers: number;
  idleTtlMs: number;
  piBin?: string;
}

export class WorkerPool {
  private readonly workers = new Map<string, PiRpcWorker>();
  private nextWorkerId = 1;

  constructor(
    private readonly options: WorkerPoolOptions,
    private readonly events: EventBus,
  ) {}

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

  read(workerId: string): PiRpcWorker {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new DaemonError("notFound", "Worker not found", { workerId });
    }
    return worker;
  }

  findByThread(threadId: string): PiRpcWorker | undefined {
    return [...this.workers.values()].find((worker) => worker.threadId === threadId);
  }

  async acquireForNew(cwd: string): Promise<PiRpcWorker> {
    const idle = [...this.workers.values()].find(
      (worker) => worker.state === "idle" && worker.cwd === cwd && !worker.threadId,
    );
    return idle ?? this.spawn(cwd);
  }

  async acquireForSession(
    threadId: string,
    cwd: string,
    sessionPath: string,
  ): Promise<PiRpcWorker> {
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
      await worker.command({ type: "switch_session", sessionPath });
      worker.threadId = threadId;
      worker.state = "assigned";
    }
    return worker;
  }

  release(worker: PiRpcWorker, threadId?: string): void {
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
    await Promise.all([...this.workers.values()].map((worker) => worker.stop()));
    this.workers.clear();
  }

  private async spawn(cwd: string): Promise<PiRpcWorker> {
    if (this.workers.size >= this.options.maxWorkers) {
      throw new DaemonError("capacity", "Worker capacity reached", {
        maxWorkers: this.options.maxWorkers,
      });
    }
    const worker = new PiRpcWorker({
      workerId: `worker_${this.nextWorkerId++}`,
      cwd,
      piBin: this.options.piBin,
    });
    this.workers.set(worker.workerId, worker);
    worker.on("event", (event) => this.events.emit(mapWorkerEvent(worker, event)));
    worker.on("exit", (event) => {
      this.events.emit({
        type: "worker.crashed",
        workerId: worker.workerId,
        threadId: worker.threadId,
        payload: { pid: worker.pid, ...(event as Record<string, unknown>) },
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
}

function mapWorkerEvent(worker: PiRpcWorker, event: unknown) {
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
