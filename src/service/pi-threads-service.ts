import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PiThreadsConfig } from "../config.ts";
import { DaemonError } from "../errors.ts";
import { isTerminalEventType, type DaemonEvent, type EventFilter } from "../protocol/events.ts";
import type {
  AcceptedTurn,
  QueuedFollowUp,
  ServerStatus,
  ThreadReadResult,
  ThreadSummary,
} from "../protocol/types.ts";
import { PI_COMPATIBILITY, VERSION } from "../version.ts";
import { PiSessionCatalog } from "../session/catalog.ts";
import { WorkerPool, type PooledWorker } from "../worker/worker-pool.ts";
import { promptDisposition, queueDisposition } from "../worker/input-disposition.ts";
import { EventBus, type EventListener } from "./event-bus.ts";

interface ThreadListParams {
  cwd?: string;
  limit?: number;
  cursor?: string;
  since?: string;
  archived?: boolean;
  sort?: "updated" | "created";
  asc?: boolean;
}

interface ThreadSearchParams extends ThreadListParams {
  query: string;
}

export class PiThreadsService {
  readonly events = new EventBus();
  readonly catalog: PiSessionCatalog;
  readonly workers: WorkerPool;
  private readonly defaults: PiThreadsConfig["defaults"];
  private readonly startedAt = Date.now();
  private readonly activeTurns = new Map<
    string,
    { turnId: string; workerId?: string; hasAgentRun?: boolean }
  >();
  private readonly turnCleanups = new Map<string, Promise<void>>();
  private readonly sessionMutations = new Set<string>();
  private transportNames: string[] = [];
  private shuttingDown = false;

  constructor(
    config: PiThreadsConfig,
    options?: { catalog?: PiSessionCatalog; workers?: WorkerPool },
  ) {
    this.defaults = config.defaults;
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
    this.events.subscribe({}, (event) => {
      void this.handleDaemonEvent(event).catch((error) => {
        this.events.emit({
          type: "thread.updated",
          threadId: event.threadId,
          turnId: event.turnId,
          workerId: event.workerId,
          payload: {
            internalError: error instanceof Error ? error.message : String(error),
            sourceEvent: event.type,
          },
        });
      });
    });
  }

  setTransports(transports: string[]): void {
    this.transportNames = transports;
  }

  serverStatus(): ServerStatus {
    return {
      version: VERSION,
      piCompatibility: PI_COMPATIBILITY,
      uptimeMs: Date.now() - this.startedAt,
      workers: this.workers.list(),
      transports: this.transportNames,
    };
  }

  async start(): Promise<void> {
    await this.workers.start();
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

  async threadList(params: ThreadListParams = {}) {
    return pageThreads(
      filterThreads(
        overlayWorkerThreadStatuses(
          await this.catalog.list(params.cwd),
          this.workers.list(),
          this.activeTurns,
          params.cwd,
        ),
        params,
      ),
      params,
    );
  }

  async threadSearch(params: ThreadSearchParams) {
    return pageThreads(
      filterThreads(
        overlayWorkerThreadStatuses(
          await this.catalog.search(params.query, params.cwd),
          this.workers.list(),
          this.activeTurns,
          params.cwd,
        ),
        params,
      ),
      params,
    );
  }

  async threadRead(params: {
    threadId: string;
    last?: number;
    asc?: boolean;
  }): Promise<ThreadReadResult> {
    const result = await this.catalog.read(params.threadId);
    return {
      ...result,
      entries: limitEntries(result.entries, params.last, params.asc),
      thread: {
        ...result.thread,
        status: this.activeTurns.has(result.thread.threadId) ? "running" : "idle",
      },
    };
  }

  async threadMessages(params: { threadId: string; last?: number; role?: string; since?: string }) {
    const worker = this.workers.findByThread(params.threadId);
    if (worker) {
      const response = await worker.command({ type: "get_messages" }, 20_000);
      const messages = ((response.data as { messages?: unknown[] } | undefined)?.messages ??
        []) as unknown[];
      return {
        threadId: params.threadId,
        messages: filterMessages(messages, params),
      };
    }
    const result = await this.catalog.messages(params.threadId);
    return {
      threadId: result.threadId,
      messages: filterMessages(result.messages, params),
    };
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
    try {
      const settings = withDefaults(params, this.defaults);
      const model =
        settings.model === undefined
          ? undefined
          : await this.resolveModelSelection(worker, settings.model);
      assertNotCancelled(await worker.command({ type: "new_session" }, 20_000), "new_session");
      let state = await worker.getState();
      if (params.name) {
        await worker.command({ type: "set_session_name", name: params.name }, 20_000);
      }
      await this.applyResolvedSettings(worker, { model, thinking: settings.thinking });
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
        this.submitPrompt(threadId, turnId, worker, params.prompt);
      } else {
        this.completePromptlessTurn(threadId, turnId, worker);
      }
      return { threadId, turnId, workerId: worker.workerId, status: "accepted" };
    } catch (error) {
      worker.activeTurnId = undefined;
      if (!worker.threadId) {
        this.workers.release(worker);
      }
      throw error;
    }
  }

  async threadSend(params: {
    threadId: string;
    prompt: string;
    model?: string;
    thinking?: string;
  }): Promise<AcceptedTurn> {
    await this.turnCleanups.get(params.threadId);
    const session = await this.catalog.resolveThread(params.threadId);
    await this.turnCleanups.get(session.id);
    this.catalog.assertUnchanged(session.id);
    const turnId = newTurnId();
    this.reserveTurn(session.id, turnId);
    try {
      const worker = await this.workers.acquireForSession(session.id, session.cwd, session.path);
      await this.applySettings(worker, params);
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
      this.submitPrompt(session.id, turnId, worker, params.prompt);
      return { threadId: session.id, turnId, workerId: worker.workerId, status: "accepted" };
    } catch (error) {
      this.activeTurns.delete(session.id);
      throw error;
    }
  }

  async threadSteer(params: { threadId: string; prompt: string }): Promise<AcceptedTurn> {
    const active = this.requireActive(params.threadId);
    const worker = this.workers.read(active.workerId);
    const disposition = queueDisposition(
      await worker.command({ type: "steer", message: params.prompt }, 20_000),
    );
    return {
      threadId: params.threadId,
      turnId: active.turnId,
      workerId: worker.workerId,
      status: "running",
      disposition,
    };
  }

  async threadFollowUp(params: { threadId: string; prompt: string }): Promise<QueuedFollowUp> {
    const active = this.requireActive(params.threadId);
    const worker = this.workers.read(active.workerId);
    const disposition = queueDisposition(
      await worker.command({ type: "follow_up", message: params.prompt }, 20_000),
    );
    return {
      threadId: params.threadId,
      ...(disposition === "queued" ? { queuedForTurnId: active.turnId } : {}),
      status: disposition,
    };
  }

  async threadAbort(params: { threadId: string }) {
    const active = this.requireActive(params.threadId);
    const worker = this.workers.read(active.workerId);
    worker.abortingTurnId = active.turnId;
    try {
      await worker.command({ type: "abort" }, 20_000);
      if (this.activeTurns.get(params.threadId)?.turnId === active.turnId) {
        this.events.emit({
          type: "turn.aborted",
          threadId: params.threadId,
          turnId: active.turnId,
          workerId: worker.workerId,
          payload: { reason: "client", finalState: "aborted" },
        });
      }
      await this.turnCleanups.get(params.threadId);
    } finally {
      if (worker.abortingTurnId === active.turnId) {
        worker.abortingTurnId = undefined;
      }
    }
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
    return this.withSessionMutation(params.threadId, async (worker, sourceThreadId) => {
      const response = await worker.command({ type: "fork", entryId: params.entryId }, 60_000);
      assertNotCancelled(response, "fork");
      if (params.name) {
        await worker.command({ type: "set_session_name", name: params.name }, 20_000);
      }
      const state = await worker.getState();
      worker.threadId = String(state.sessionId);
      return { threadId: worker.threadId, sourceThreadId, data: response.data };
    });
  }

  async threadClone(params: { threadId: string; name?: string }) {
    return this.withSessionMutation(params.threadId, async (worker, sourceThreadId) => {
      assertNotCancelled(await worker.command({ type: "clone" }, 60_000), "clone");
      if (params.name) {
        await worker.command({ type: "set_session_name", name: params.name }, 20_000);
      }
      const state = await worker.getState();
      worker.threadId = String(state.sessionId);
      return { threadId: worker.threadId, sourceThreadId };
    });
  }

  async threadNameSet(params: { threadId: string; name: string }) {
    return this.withSessionMutation(params.threadId, async (worker, threadId) => {
      await worker.command({ type: "set_session_name", name: params.name }, 20_000);
      return { threadId, name: params.name };
    });
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
    return this.withSessionMutation(params.threadId, async (worker, threadId) => {
      await this.applySettings(worker, params);
      if (params.steeringMode) {
        await worker.command({ type: "set_steering_mode", mode: params.steeringMode }, 20_000);
      }
      if (params.followUpMode) {
        await worker.command({ type: "set_follow_up_mode", mode: params.followUpMode }, 20_000);
      }
      if (params.autoCompaction !== undefined) {
        await worker.command(
          { type: "set_auto_compaction", enabled: params.autoCompaction },
          20_000,
        );
      }
      if (params.autoRetry !== undefined) {
        await worker.command({ type: "set_auto_retry", enabled: params.autoRetry }, 20_000);
      }
      return { threadId, settings: await worker.getState() };
    });
  }

  async threadCompact(params: { threadId: string; prompt?: string }) {
    return this.withSessionMutation(params.threadId, async (worker, threadId) => {
      const response = await worker.command(
        { type: "compact", customInstructions: params.prompt },
        10 * 60_000,
      );
      return { threadId, result: response.data };
    });
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
    return this.withSessionMutation(params.threadId, async (worker, threadId) => {
      const response = await worker.command({ type: "bash", command: params.command }, 10 * 60_000);
      return { threadId, result: response.data };
    });
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
    const response = isRecord(params.response) ? params.response : { value: params.response };
    worker.sendRaw({
      ...response,
      id: params.requestId,
      type: "extension_ui_response",
    });
    this.events.emit({
      type: "extension_ui.completed",
      threadId: params.threadId,
      workerId: worker.workerId,
      payload: { requestId: params.requestId, status: "responded" },
    });
    return { threadId: params.threadId, requestId: params.requestId, status: "responded" };
  }

  async modelsList(params: { provider?: string } = {}) {
    const worker = await this.workers.acquireForNew(process.cwd());
    try {
      const response = await worker.command({ type: "get_available_models" }, 30_000);
      const data = (response.data ?? { models: [] }) as Record<string, unknown>;
      if (!params.provider || !Array.isArray(data.models)) {
        return data;
      }
      return {
        ...data,
        models: data.models.filter(
          (model) =>
            model &&
            typeof model === "object" &&
            (model as Record<string, unknown>).provider === params.provider,
        ),
      };
    } finally {
      this.workers.release(worker);
    }
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
        return this.threadRead(params as { threadId: string; last?: number; asc?: boolean });
      case "thread/messages":
        return this.threadMessages(
          params as { threadId: string; last?: number; role?: string; since?: string },
        );
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
        return this.modelsList(params as { provider?: string });
      case "usage/read":
        return this.usageRead(params as { threadId?: string });
      default:
        throw new DaemonError("notFound", "Unknown method", { method });
    }
  }

  private requireActive(threadId: string): { turnId: string; workerId: string } {
    const active = this.activeTurns.get(threadId);
    if (!active?.workerId) {
      throw new DaemonError("busy", "Thread does not have a running daemon turn", { threadId });
    }
    return { turnId: active.turnId, workerId: active.workerId };
  }

  private async workerForRequiredMethod(threadId: string): Promise<PooledWorker> {
    await this.turnCleanups.get(threadId);
    const assigned = this.workers.findByThread(threadId);
    if (assigned) {
      return assigned;
    }
    const session = await this.catalog.resolveThread(threadId);
    await this.turnCleanups.get(session.id);
    return this.workers.acquireForSession(session.id, session.cwd, session.path);
  }

  private async withSessionMutation<T>(
    threadId: string,
    mutate: (worker: PooledWorker, threadId: string) => Promise<T>,
  ): Promise<T> {
    await this.turnCleanups.get(threadId);
    const session = await this.catalog.resolveThread(threadId);
    await this.turnCleanups.get(session.id);
    if (this.activeTurns.has(session.id) || this.sessionMutations.has(session.id)) {
      throw new DaemonError("busy", "Thread already has active daemon work", {
        threadId: session.id,
      });
    }
    this.catalog.assertUnchanged(session.id);
    this.sessionMutations.add(session.id);
    let worker: PooledWorker | undefined;
    try {
      worker = await this.workers.acquireForSession(session.id, session.cwd, session.path);
      worker.state = "running";
      return await mutate(worker, session.id);
    } finally {
      try {
        if (worker && (worker.state === "crashed" || worker.state === "stopped")) {
          await this.refreshOwnedSession(session.id);
        } else if (worker) {
          const state = await worker.getState();
          worker.threadId = String(state.sessionId ?? session.id);
          this.catalog.updateFromWorkerState({
            sessionId: worker.threadId,
            sessionFile: String(state.sessionFile ?? ""),
            cwd: worker.cwd,
            sessionName: typeof state.sessionName === "string" ? state.sessionName : undefined,
          });
        }
      } catch (error) {
        this.events.emit({
          type: "thread.updated",
          threadId: worker?.threadId ?? session.id,
          workerId: worker?.workerId,
          payload: {
            internalError: error instanceof Error ? error.message : String(error),
            operation: "session.refresh",
          },
        });
      } finally {
        this.sessionMutations.delete(session.id);
        if (worker) this.workers.release(worker);
      }
    }
  }

  private async applySettings(
    worker: PooledWorker,
    params: { model?: string; thinking?: string },
  ): Promise<void> {
    if (params.model) {
      const { provider, modelId } = await this.resolveModelSelection(worker, params.model);
      await this.applyResolvedSettings(worker, { model: { provider, modelId } });
    }
    if (params.thinking) {
      await this.applyResolvedSettings(worker, { thinking: params.thinking });
    }
  }

  private async applyResolvedSettings(
    worker: PooledWorker,
    params: { model?: { provider: string; modelId: string }; thinking?: string },
  ): Promise<void> {
    if (params.model) {
      await worker.command(
        { type: "set_model", provider: params.model.provider, modelId: params.model.modelId },
        20_000,
      );
    }
    if (params.thinking) {
      await worker.command({ type: "set_thinking_level", level: params.thinking }, 20_000);
    }
  }

  private async resolveModelSelection(
    worker: PooledWorker,
    model: string,
  ): Promise<{ provider: string; modelId: string }> {
    let explicitProvider: string | undefined;
    let explicitModel: string | undefined;
    if (model.includes("/")) {
      const slash = model.indexOf("/");
      explicitProvider = model.slice(0, slash);
      explicitModel = model.slice(slash + 1);
      if (!explicitProvider || !explicitModel) {
        throw new DaemonError("invalidParams", "Model must be provider/modelId", { model });
      }
    }
    const response = await worker.command({ type: "get_available_models" }, 30_000);
    const models = ((response.data as { models?: Array<Record<string, unknown>> } | undefined)
      ?.models ?? []) as Array<Record<string, unknown>>;
    const match = models.find((candidate) => {
      if (explicitProvider && candidate.provider !== explicitProvider) return false;
      return (
        candidate.id === (explicitModel ?? model) || candidate.name === (explicitModel ?? model)
      );
    });
    if (!match || typeof match.provider !== "string" || typeof match.id !== "string") {
      if (explicitProvider && explicitModel && !explicitModel.includes("/")) {
        return { provider: explicitProvider, modelId: explicitModel };
      }
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

  private completePromptlessTurn(threadId: string, turnId: string, worker: PooledWorker): void {
    queueMicrotask(() => {
      if (this.activeTurns.get(threadId)?.turnId !== turnId) {
        return;
      }
      this.events.emit({
        type: "turn.completed",
        threadId,
        turnId,
        workerId: worker.workerId,
        payload: { status: "completed", promptless: true },
      });
    });
  }

  private submitPrompt(
    threadId: string,
    turnId: string,
    worker: PooledWorker,
    message: string,
  ): void {
    void worker
      .command({ type: "prompt", message }, 20_000)
      .then((response) => {
        const disposition = promptDisposition(response);
        const active = this.activeTurns.get(threadId);
        if (active?.turnId !== turnId || disposition !== "handled" || active.hasAgentRun) {
          return;
        }
        this.events.emit({
          type: "turn.completed",
          threadId,
          turnId,
          workerId: worker.workerId,
          payload: { status: "completed", disposition },
        });
      })
      .catch((error) => this.failTurn(threadId, turnId, worker, error));
  }

  private failTurn(threadId: string, turnId: string, worker: PooledWorker, error: unknown): void {
    if (this.activeTurns.get(threadId)?.turnId !== turnId) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.events.emit({
      type: "turn.failed",
      threadId,
      turnId,
      workerId: worker.workerId,
      payload: { errorCode: "piRpcError", message },
    });
  }

  private reserveTurn(threadId: string, turnId: string): void {
    if (this.activeTurns.has(threadId) || this.sessionMutations.has(threadId)) {
      throw new DaemonError("busy", "Thread already has active daemon work", { threadId });
    }
    this.activeTurns.set(threadId, { turnId });
  }

  private async handleDaemonEvent(event: DaemonEvent): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    if (!event.threadId || !event.turnId) {
      return;
    }
    const active = this.activeTurns.get(event.threadId);
    if (!active?.workerId || active.turnId !== event.turnId) {
      return;
    }
    if (event.type === "turn.started") {
      active.hasAgentRun = true;
      return;
    }
    if (!isTerminalEventType(event.type)) {
      return;
    }
    this.activeTurns.delete(event.threadId);
    const worker = this.workers.findByThread(event.threadId);
    if (worker?.workerId === active.workerId) {
      worker.activeTurnId = undefined;
    }
    let cleanup: Promise<void>;
    if (
      !worker ||
      worker.workerId !== active.workerId ||
      worker.state === "crashed" ||
      worker.state === "stopped"
    ) {
      cleanup = this.refreshOwnedSession(event.threadId);
    } else {
      this.workers.release(worker, event.threadId);
      cleanup = this.refreshWorkerSession(worker, event.threadId);
    }
    this.turnCleanups.set(event.threadId, cleanup);
    try {
      await cleanup;
    } finally {
      if (this.turnCleanups.get(event.threadId) === cleanup) {
        this.turnCleanups.delete(event.threadId);
      }
    }
  }

  private async refreshOwnedSession(threadId: string): Promise<void> {
    const session = await this.catalog.resolveThread(threadId);
    this.catalog.updateFromWorkerState({
      sessionId: session.id,
      sessionFile: session.path,
      cwd: session.cwd,
      sessionName: session.name,
    });
  }

  private async refreshWorkerSession(worker: PooledWorker, threadId: string): Promise<void> {
    const state = await worker.getState().catch(() => undefined);
    if (state && worker.threadId === threadId && !worker.activeTurnId) {
      this.catalog.updateFromWorkerState({
        sessionId: String(state.sessionId ?? threadId),
        sessionFile: String(state.sessionFile ?? ""),
        cwd: worker.cwd,
        sessionName: typeof state.sessionName === "string" ? state.sessionName : undefined,
      });
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withDefaults<T extends { model?: string; thinking?: string }>(
  params: T,
  defaults: PiThreadsConfig["defaults"],
): T {
  return {
    ...params,
    model: params.model ?? defaults.model,
    thinking: params.thinking ?? defaults.thinking,
  };
}

function limitEntries(
  entries: unknown[] | undefined,
  last: number | undefined,
  asc: boolean | undefined,
): unknown[] | undefined {
  if (!entries) {
    return entries;
  }
  let messages = entries.filter((entry) => isMessageEntry(entry));
  if (asc === false) {
    messages = [...messages].reverse();
  }
  if (last !== undefined && last <= 0) {
    return [];
  }
  if (last !== undefined) {
    messages = asc === false ? messages.slice(0, last).reverse() : messages.slice(-last);
  }
  return messages;
}

function filterMessages(
  messages: unknown[],
  options: { last?: number; role?: string; since?: string },
): unknown[] {
  const since = parseSince(options.since);
  let filtered = messages;
  if (options.role) {
    const role = piRole(options.role);
    filtered = filtered.filter((message) => messageRole(message) === role);
  }
  if (since !== undefined) {
    filtered = filtered.filter((message) => {
      const timestamp = messageTimestamp(message);
      return timestamp !== undefined && timestamp >= since;
    });
  }
  if (options.last !== undefined) {
    filtered = options.last <= 0 ? [] : filtered.slice(-options.last);
  }
  return filtered;
}

function isMessageEntry(entry: unknown): boolean {
  return Boolean(
    entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "message",
  );
}

function messageRole(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return (message as Record<string, unknown>).role;
}

function piRole(role: string): string {
  if (role === "tool") {
    return "toolResult";
  }
  if (role === "bash") {
    return "bashExecution";
  }
  return role;
}

function messageTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  const raw = record.createdAt ?? record.timestamp;
  if (typeof raw === "number") {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function parseSince(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }
  const relative = trimmed.match(/^(\d+)(ms|s|m|h|d|w)$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]?.toLowerCase();
    const multiplier =
      unit === "ms"
        ? 1
        : unit === "s"
          ? 1_000
          : unit === "m"
            ? 60_000
            : unit === "h"
              ? 3_600_000
              : unit === "d"
                ? 86_400_000
                : 604_800_000;
    return Date.now() - amount * multiplier;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new DaemonError("invalidParams", "Invalid --since value", { since: value });
  }
  return parsed;
}

function filterThreads(threads: ThreadSummary[], options: ThreadListParams): ThreadSummary[] {
  if (options.archived) {
    throw new DaemonError("invalidParams", "Pi session archive filtering is not supported", {
      archived: true,
    });
  }
  const since = parseSince(options.since);
  const filtered =
    since === undefined ? threads : threads.filter((thread) => threadTime(thread) >= since);
  const sort = options.sort ?? "updated";
  const ascending = options.asc === true;
  return [...filtered].sort((left, right) => {
    const leftValue = sort === "created" ? threadCreatedTime(left) : threadUpdatedTime(left);
    const rightValue = sort === "created" ? threadCreatedTime(right) : threadUpdatedTime(right);
    return ascending ? leftValue - rightValue : rightValue - leftValue;
  });
}

function pageThreads(threads: ThreadSummary[], options: ThreadListParams) {
  const offset = options.cursor ? Number(options.cursor) : 0;
  const limit = options.limit ?? 50;
  return {
    threads: threads.slice(offset, offset + limit),
    cursor: offset + limit < threads.length ? String(offset + limit) : undefined,
  };
}

function threadTime(thread: ThreadSummary): number {
  return threadUpdatedTime(thread);
}

function threadUpdatedTime(thread: ThreadSummary): number {
  return parseThreadDate(thread.modified ?? thread.created);
}

function threadCreatedTime(thread: ThreadSummary): number {
  return parseThreadDate(thread.created ?? thread.modified);
}

function parseThreadDate(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function overlayWorkerThreadStatuses(
  catalogThreads: ThreadSummary[],
  workers: ReturnType<WorkerPool["list"]>,
  activeTurns: Map<string, { turnId: string; workerId?: string }>,
  cwd?: string,
): ThreadSummary[] {
  const resolvedCwd = cwd ? resolve(cwd) : undefined;
  const threads = catalogThreads.map((thread) => ({ ...thread }));
  for (const worker of workers) {
    if (!worker.threadId || (resolvedCwd && worker.cwd !== resolvedCwd)) {
      continue;
    }
    const status =
      worker.state === "running" || activeTurns.has(worker.threadId) ? "running" : "idle";
    const existing = threads.find((thread) => thread.threadId === worker.threadId);
    if (existing) {
      existing.status = status;
      continue;
    }
    threads.push({
      threadId: worker.threadId,
      cwd: worker.cwd,
      messageCount: 0,
      status,
    });
  }
  return threads;
}

function assertNotCancelled(response: { data?: unknown }, command: string): void {
  if (
    response.data &&
    typeof response.data === "object" &&
    (response.data as Record<string, unknown>).cancelled === true
  ) {
    throw new DaemonError("piRpcError", "Pi RPC command was cancelled", { command });
  }
}
