import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PiThreadsConfig } from "../config.ts";
import { DaemonError } from "../errors.ts";
import type { DaemonEvent, EventFilter } from "../protocol/events.ts";
import type {
  AcceptedTurn,
  QueuedFollowUp,
  ServerStatus,
  SubscriptionRequest,
  ThreadReadResult,
} from "../protocol/types.ts";
import { PI_COMPATIBILITY, VERSION } from "../version.ts";
import { PiSessionCatalog } from "../session/catalog.ts";
import type { PiRpcWorker } from "../worker/pi-rpc-worker.ts";
import { WorkerPool } from "../worker/worker-pool.ts";
import { EventBus, type EventListener } from "./event-bus.ts";

export class PiThreadsService {
  readonly events = new EventBus();
  readonly catalog: PiSessionCatalog;
  readonly workers: WorkerPool;
  private readonly startedAt = Date.now();
  private readonly activeTurns = new Map<string, { turnId: string; workerId: string }>();
  private shuttingDown = false;

  constructor(
    config: PiThreadsConfig,
    options?: { catalog?: PiSessionCatalog; workers?: WorkerPool },
  ) {
    this.catalog = options?.catalog ?? new PiSessionCatalog();
    this.workers =
      options?.workers ??
      new WorkerPool(
        {
          minWorkers: config.daemon.worker.minWorkers,
          maxWorkers: config.daemon.worker.maxWorkers,
          idleTtlMs: config.daemon.worker.idleTtlMs,
        },
        this.events,
      );
    this.events.subscribe({}, (event) => void this.handleDaemonEvent(event));
  }

  serverStatus(transports: string[] = []): ServerStatus {
    return {
      version: VERSION,
      piCompatibility: PI_COMPATIBILITY,
      uptimeMs: Date.now() - this.startedAt,
      workers: this.workers.list(),
      transports,
    };
  }

  async shutdown(): Promise<{ ok: true }> {
    this.shuttingDown = true;
    await this.workers.stopAll();
    return { ok: true };
  }

  async workerList() {
    return { workers: this.workers.list() };
  }

  async workerRead(params: { workerId: string }) {
    const worker = this.workers.read(params.workerId);
    return { worker: this.workers.list().find((item) => item.workerId === worker.workerId) };
  }

  async threadList(params: { cwd?: string; limit?: number; cursor?: string } = {}) {
    const threads = await this.catalog.list(params.cwd);
    for (const worker of this.workers.list()) {
      if (!worker.threadId || (params.cwd && worker.cwd !== resolve(params.cwd))) {
        continue;
      }
      if (threads.some((thread) => thread.threadId === worker.threadId)) {
        continue;
      }
      threads.push({
        threadId: worker.threadId,
        cwd: worker.cwd,
        messageCount: 0,
        status: worker.state === "running" ? "running" : "idle",
      });
    }
    const offset = params.cursor ? Number(params.cursor) : 0;
    const limit = params.limit ?? 50;
    return {
      threads: threads.slice(offset, offset + limit),
      cursor: offset + limit < threads.length ? String(offset + limit) : undefined,
    };
  }

  async threadSearch(params: { query: string; cwd?: string; limit?: number }) {
    return { threads: await this.catalog.search(params.query, params.cwd, params.limit) };
  }

  async threadRead(params: { threadId: string }): Promise<ThreadReadResult> {
    const result = await this.catalog.read(params.threadId);
    return {
      ...result,
      thread: {
        ...result.thread,
        status: this.activeTurns.has(result.thread.threadId) ? "running" : "idle",
      },
    };
  }

  async threadMessages(params: { threadId: string; last?: number; role?: string }) {
    const worker = this.workers.findByThread(params.threadId);
    if (worker) {
      const response = await worker.command({ type: "get_messages" }, 20_000);
      const messages = ((response.data as { messages?: unknown[] } | undefined)?.messages ??
        []) as unknown[];
      return {
        threadId: params.threadId,
        messages: params.last ? messages.slice(-params.last) : messages,
      };
    }
    return this.catalog.messages(params.threadId, { last: params.last, role: params.role });
  }

  async threadStart(params: {
    cwd: string;
    prompt?: string;
    name?: string;
    model?: string;
    thinking?: string;
  }): Promise<AcceptedTurn> {
    const cwd = resolve(params.cwd);
    const worker = await this.workers.acquireForNew(cwd);
    worker.state = "assigned";
    await worker.command({ type: "new_session" }, 20_000);
    let state = await worker.getState();
    if (params.name) {
      await worker.command({ type: "set_session_name", name: params.name }, 20_000);
    }
    await this.applySettings(worker, params);
    state = await worker.getState();
    const threadId = String(state.sessionId);
    worker.threadId = threadId;
    this.catalog.updateFromWorkerState({
      sessionId: threadId,
      sessionFile: String(state.sessionFile ?? ""),
      cwd,
      sessionName: params.name,
    });
    const turnId = newTurnId();
    worker.activeTurnId = turnId;
    this.activeTurns.set(threadId, { turnId, workerId: worker.workerId });
    this.events.emit({
      type: "turn.accepted",
      threadId,
      turnId,
      workerId: worker.workerId,
      payload: { promptPreview: preview(params.prompt), cwd },
    });
    if (params.prompt) {
      worker.state = "running";
      void worker
        .command({ type: "prompt", message: params.prompt }, 20_000)
        .catch((error) => this.failTurn(threadId, turnId, worker, error));
    } else {
      this.completePromptlessTurn(threadId, turnId, worker);
    }
    return { threadId, turnId, workerId: worker.workerId, status: "accepted" };
  }

  async threadSend(params: {
    threadId: string;
    prompt: string;
    model?: string;
    thinking?: string;
  }): Promise<AcceptedTurn> {
    const session = await this.catalog.resolveThread(params.threadId);
    this.catalog.assertUnchanged(session.id);
    const worker = await this.workers.acquireForSession(session.id, session.cwd, session.path);
    await this.applySettings(worker, params);
    const turnId = newTurnId();
    worker.activeTurnId = turnId;
    worker.threadId = session.id;
    worker.state = "running";
    this.activeTurns.set(session.id, { turnId, workerId: worker.workerId });
    this.events.emit({
      type: "turn.accepted",
      threadId: session.id,
      turnId,
      workerId: worker.workerId,
      payload: { promptPreview: preview(params.prompt) },
    });
    void worker
      .command({ type: "prompt", message: params.prompt }, 20_000)
      .catch((error) => this.failTurn(session.id, turnId, worker, error));
    return { threadId: session.id, turnId, workerId: worker.workerId, status: "accepted" };
  }

  async threadSteer(params: { threadId: string; prompt: string }): Promise<AcceptedTurn> {
    const active = this.requireActive(params.threadId);
    const worker = this.workers.read(active.workerId);
    await worker.command({ type: "steer", message: params.prompt }, 20_000);
    this.events.emit({
      type: "queue.updated",
      threadId: params.threadId,
      turnId: active.turnId,
      workerId: worker.workerId,
      payload: { mode: "steer", pendingCount: 1, acceptedPromptId: active.turnId },
    });
    return {
      threadId: params.threadId,
      turnId: active.turnId,
      workerId: worker.workerId,
      status: "running",
    };
  }

  async threadFollowUp(params: { threadId: string; prompt: string }): Promise<QueuedFollowUp> {
    const active = this.requireActive(params.threadId);
    const worker = this.workers.read(active.workerId);
    await worker.command({ type: "follow_up", message: params.prompt }, 20_000);
    this.events.emit({
      type: "queue.updated",
      threadId: params.threadId,
      turnId: active.turnId,
      workerId: worker.workerId,
      payload: { mode: "follow_up", pendingCount: 1, acceptedPromptId: active.turnId },
    });
    return { threadId: params.threadId, queuedForTurnId: active.turnId, status: "queued" };
  }

  async threadAbort(params: { threadId: string }) {
    const active = this.requireActive(params.threadId);
    const worker = this.workers.read(active.workerId);
    await worker.command({ type: "abort" }, 20_000);
    worker.activeTurnId = undefined;
    this.activeTurns.delete(params.threadId);
    this.workers.release(worker, params.threadId);
    this.events.emit({
      type: "turn.aborted",
      threadId: params.threadId,
      turnId: active.turnId,
      workerId: worker.workerId,
      payload: { reason: "client", finalState: "aborted" },
    });
    return { threadId: params.threadId, turnId: active.turnId, status: "aborted" };
  }

  async threadStatus(params?: { threadId?: string }) {
    if (!params?.threadId) {
      return this.serverStatus();
    }
    const worker = this.workers.findByThread(params.threadId);
    if (!worker) {
      const session = await this.catalog.resolveThread(params.threadId);
      return { threadId: session.id, status: "idle", path: session.path, cwd: session.cwd };
    }
    const state = await worker.getState();
    return {
      threadId: params.threadId,
      status: worker.state === "running" || state.isStreaming ? "running" : "idle",
      workerId: worker.workerId,
      state,
    };
  }

  async threadFork(params: { threadId: string; entryId: string; name?: string }) {
    if (this.activeTurns.has(params.threadId)) {
      throw new DaemonError("busy", "Cannot fork a thread with an active daemon turn", {
        threadId: params.threadId,
      });
    }
    const session = await this.catalog.resolveThread(params.threadId);
    const worker = await this.workers.acquireForSession(session.id, session.cwd, session.path);
    const response = await worker.command({ type: "fork", entryId: params.entryId }, 60_000);
    if (params.name) {
      await worker.command({ type: "set_session_name", name: params.name }, 20_000);
    }
    const state = await worker.getState();
    worker.threadId = String(state.sessionId);
    this.catalog.updateFromWorkerState({
      sessionId: String(state.sessionId),
      sessionFile: String(state.sessionFile ?? ""),
      cwd: session.cwd,
      sessionName: params.name,
    });
    return { threadId: String(state.sessionId), sourceThreadId: session.id, data: response.data };
  }

  async threadClone(params: { threadId: string; name?: string }) {
    const session = await this.catalog.resolveThread(params.threadId);
    const worker = await this.workers.acquireForSession(session.id, session.cwd, session.path);
    await worker.command({ type: "clone" }, 60_000);
    if (params.name) {
      await worker.command({ type: "set_session_name", name: params.name }, 20_000);
    }
    const state = await worker.getState();
    worker.threadId = String(state.sessionId);
    this.catalog.updateFromWorkerState({
      sessionId: String(state.sessionId),
      sessionFile: String(state.sessionFile ?? ""),
      cwd: session.cwd,
      sessionName: params.name,
    });
    return { threadId: String(state.sessionId), sourceThreadId: session.id };
  }

  async threadNameSet(params: { threadId: string; name: string }) {
    const worker = await this.workerForRequiredMethod(params.threadId);
    await worker.command({ type: "set_session_name", name: params.name }, 20_000);
    const state = await worker.getState();
    this.catalog.updateFromWorkerState({
      sessionId: params.threadId,
      sessionFile: String(state.sessionFile ?? ""),
      cwd: worker.cwd,
      sessionName: params.name,
    });
    return { threadId: params.threadId, name: params.name };
  }

  async threadSettingsRead(params: { threadId: string }) {
    const worker = await this.workerForRequiredMethod(params.threadId);
    const state = await worker.getState();
    return { threadId: params.threadId, settings: state };
  }

  async threadSettingsUpdate(params: {
    threadId: string;
    model?: string;
    thinking?: string;
    steeringMode?: "all" | "one-at-a-time";
    followUpMode?: "all" | "one-at-a-time";
    autoCompaction?: boolean;
    autoRetry?: boolean;
  }) {
    const worker = await this.workerForRequiredMethod(params.threadId);
    await this.applySettings(worker, params);
    if (params.steeringMode) {
      await worker.command({ type: "set_steering_mode", mode: params.steeringMode }, 20_000);
    }
    if (params.followUpMode) {
      await worker.command({ type: "set_follow_up_mode", mode: params.followUpMode }, 20_000);
    }
    if (params.autoCompaction !== undefined) {
      await worker.command({ type: "set_auto_compaction", enabled: params.autoCompaction }, 20_000);
    }
    if (params.autoRetry !== undefined) {
      await worker.command({ type: "set_auto_retry", enabled: params.autoRetry }, 20_000);
    }
    return this.threadSettingsRead({ threadId: params.threadId });
  }

  async threadCompact(params: { threadId: string; prompt?: string }) {
    const worker = await this.workerForRequiredMethod(params.threadId);
    this.events.emit({
      type: "compaction.started",
      threadId: params.threadId,
      workerId: worker.workerId,
      payload: { reason: "client" },
    });
    const response = await worker.command(
      { type: "compact", customInstructions: params.prompt },
      10 * 60_000,
    );
    this.events.emit({
      type: "compaction.completed",
      threadId: params.threadId,
      workerId: worker.workerId,
      payload: { status: "completed" },
    });
    return { threadId: params.threadId, result: response.data };
  }

  async threadExportHtml(params: { threadId: string }) {
    const worker = await this.workerForRequiredMethod(params.threadId);
    const temp = mkdtempSync(join(tmpdir(), "pi-threads-export-"));
    const outputPath = join(temp, "session.html");
    try {
      const response = await worker.command({ type: "export_html", outputPath }, 60_000);
      const path = String((response.data as { path?: string } | undefined)?.path ?? outputPath);
      return { threadId: params.threadId, html: readFileSync(path, "utf8") };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  async threadBashRun(params: { threadId: string; command: string }) {
    if (this.activeTurns.has(params.threadId)) {
      throw new DaemonError("busy", "Bash is rejected while a daemon turn is active", {
        threadId: params.threadId,
      });
    }
    const worker = await this.workerForRequiredMethod(params.threadId);
    const response = await worker.command({ type: "bash", command: params.command }, 10 * 60_000);
    return { threadId: params.threadId, result: response.data };
  }

  async threadBashAbort(params: { threadId: string }) {
    const worker = await this.workerForRequiredMethod(params.threadId);
    await worker.command({ type: "abort_bash" }, 20_000);
    return { threadId: params.threadId, status: "aborted" };
  }

  async threadCommandsList(params: { threadId: string }) {
    const worker = await this.workerForRequiredMethod(params.threadId);
    const response = await worker.command({ type: "get_commands" }, 20_000);
    return { threadId: params.threadId, ...(response.data as Record<string, unknown>) };
  }

  async threadContextStats(params: { threadId: string }) {
    const worker = await this.workerForRequiredMethod(params.threadId);
    const response = await worker.command({ type: "get_session_stats" }, 20_000);
    return { threadId: params.threadId, stats: response.data };
  }

  async threadExtensionUiRespond(params: {
    threadId: string;
    requestId: string;
    response: unknown;
  }) {
    const worker = await this.workerForRequiredMethod(params.threadId);
    worker.sendRaw({
      type: "extension_ui_response",
      id: params.requestId,
      ...(params.response as object),
    });
    this.events.emit({
      type: "extension_ui.completed",
      threadId: params.threadId,
      workerId: worker.workerId,
      payload: { requestId: params.requestId, status: "responded" },
    });
    return { threadId: params.threadId, requestId: params.requestId, status: "responded" };
  }

  async modelsList() {
    const worker = await this.workers.acquireForNew(process.cwd());
    const response = await worker.command({ type: "get_available_models" }, 30_000);
    this.workers.release(worker);
    return response.data ?? { models: [] };
  }

  async usageRead(params: { threadId?: string } = {}) {
    if (!params.threadId) {
      return { usage: { scope: "daemon", bestEffort: true, workers: this.workers.list().length } };
    }
    return this.threadContextStats({ threadId: params.threadId });
  }

  subscribe(filter: EventFilter, listener: EventListener): string {
    return this.events.subscribe(filter, listener);
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.events.unsubscribe(subscriptionId);
  }

  async dispatch(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    switch (method) {
      case "server/status":
        return this.serverStatus();
      case "server/shutdown":
        return this.shutdown();
      case "worker/list":
        return this.workerList();
      case "worker/read":
        return this.workerRead(params as { workerId: string });
      case "thread/list":
        return this.threadList(params);
      case "thread/search":
        return this.threadSearch(params as { query: string });
      case "thread/read":
        return this.threadRead(params as { threadId: string });
      case "thread/messages":
        return this.threadMessages(params as { threadId: string });
      case "thread/start":
        return this.threadStart(params as Parameters<PiThreadsService["threadStart"]>[0]);
      case "thread/send":
        return this.threadSend(params as Parameters<PiThreadsService["threadSend"]>[0]);
      case "thread/steer":
        return this.threadSteer(params as { threadId: string; prompt: string });
      case "thread/follow_up":
        return this.threadFollowUp(params as { threadId: string; prompt: string });
      case "thread/abort":
        return this.threadAbort(params as { threadId: string });
      case "thread/status":
        return this.threadStatus(params);
      case "thread/fork":
        return this.threadFork(params as { threadId: string; entryId: string; name?: string });
      case "thread/clone":
        return this.threadClone(params as { threadId: string; name?: string });
      case "thread/name/set":
        return this.threadNameSet(params as { threadId: string; name: string });
      case "thread/settings/read":
        return this.threadSettingsRead(params as { threadId: string });
      case "thread/settings/update":
        return this.threadSettingsUpdate(
          params as Parameters<PiThreadsService["threadSettingsUpdate"]>[0],
        );
      case "thread/compact":
        return this.threadCompact(params as { threadId: string; prompt?: string });
      case "thread/export/html":
        return this.threadExportHtml(params as { threadId: string });
      case "thread/bash/run":
        return this.threadBashRun(params as { threadId: string; command: string });
      case "thread/bash/abort":
        return this.threadBashAbort(params as { threadId: string });
      case "thread/commands/list":
        return this.threadCommandsList(params as { threadId: string });
      case "thread/context/stats":
        return this.threadContextStats(params as { threadId: string });
      case "thread/extension-ui/respond":
        return this.threadExtensionUiRespond(
          params as { threadId: string; requestId: string; response: unknown },
        );
      case "models/list":
        return this.modelsList();
      case "usage/read":
        return this.usageRead(params as { threadId?: string });
      case "subscribe/thread":
      case "subscribe/all":
      case "subscribe/workers":
        return { subscription: "adapter-owned", filter: params as SubscriptionRequest };
      case "unsubscribe/thread":
        return { ok: true };
      default:
        throw new DaemonError("notFound", "Unknown method", { method });
    }
  }

  private requireActive(threadId: string): { turnId: string; workerId: string } {
    const active = this.activeTurns.get(threadId);
    if (!active) {
      throw new DaemonError("busy", "Thread does not have a running daemon turn", { threadId });
    }
    return active;
  }

  private async workerForRequiredMethod(threadId: string): Promise<PiRpcWorker> {
    const assigned = this.workers.findByThread(threadId);
    if (assigned) {
      return assigned;
    }
    const session = await this.catalog.resolveThread(threadId);
    return this.workers.acquireForSession(session.id, session.cwd, session.path);
  }

  private async applySettings(
    worker: PiRpcWorker,
    params: { model?: string; thinking?: string },
  ): Promise<void> {
    if (params.model) {
      const { provider, modelId } = await this.resolveModelSelection(worker, params.model);
      await worker.command({ type: "set_model", provider, modelId }, 20_000);
    }
    if (params.thinking) {
      await worker.command({ type: "set_thinking_level", level: params.thinking }, 20_000);
    }
  }

  private async resolveModelSelection(
    worker: PiRpcWorker,
    model: string,
  ): Promise<{ provider: string; modelId: string }> {
    if (model.includes("/")) {
      const [provider, modelId] = model.split("/", 2);
      return { provider, modelId };
    }
    const response = await worker.command({ type: "get_available_models" }, 30_000);
    const models = ((response.data as { models?: Array<Record<string, unknown>> } | undefined)
      ?.models ?? []) as Array<Record<string, unknown>>;
    const match = models.find((candidate) => candidate.id === model || candidate.name === model);
    if (!match || typeof match.provider !== "string" || typeof match.id !== "string") {
      throw new DaemonError(
        "invalidParams",
        "Model must be provider/modelId or match a configured Pi model id",
        {
          model,
        },
      );
    }
    return { provider: match.provider, modelId: match.id };
  }

  private completePromptlessTurn(threadId: string, turnId: string, worker: PiRpcWorker): void {
    queueMicrotask(() => {
      this.activeTurns.delete(threadId);
      worker.activeTurnId = undefined;
      this.workers.release(worker, threadId);
      this.events.emit({
        type: "turn.completed",
        threadId,
        turnId,
        workerId: worker.workerId,
        payload: { status: "completed", promptless: true },
      });
    });
  }

  private failTurn(threadId: string, turnId: string, worker: PiRpcWorker, error: unknown): void {
    this.activeTurns.delete(threadId);
    worker.activeTurnId = undefined;
    this.workers.release(worker, threadId);
    const message = error instanceof Error ? error.message : String(error);
    this.events.emit({
      type: "turn.failed",
      threadId,
      turnId,
      workerId: worker.workerId,
      payload: { errorCode: "piRpcError", message },
    });
  }

  private async handleDaemonEvent(event: DaemonEvent): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    if (event.type !== "turn.completed" || !event.threadId || !event.turnId) {
      return;
    }
    const active = this.activeTurns.get(event.threadId);
    if (!active || active.turnId !== event.turnId) {
      return;
    }
    this.activeTurns.delete(event.threadId);
    const worker = this.workers.read(active.workerId);
    worker.activeTurnId = undefined;
    const state = await worker.getState().catch(() => undefined);
    if (state) {
      this.catalog.updateFromWorkerState({
        sessionId: String(state.sessionId ?? event.threadId),
        sessionFile: String(state.sessionFile ?? ""),
        cwd: worker.cwd,
        sessionName: typeof state.sessionName === "string" ? state.sessionName : undefined,
      });
    }
    this.workers.release(worker, event.threadId);
  }
}

function newTurnId(): string {
  return `turn_${crypto.randomUUID()}`;
}

function preview(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}
