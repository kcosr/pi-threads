import { describe, expect, it } from "vitest";
import { defaultConfig, type PiThreadsConfig } from "../src/config.ts";
import { PiThreadsService } from "../src/service/pi-threads-service.ts";
import type { PiSessionCatalog } from "../src/session/catalog.ts";
import type { PooledWorker, WorkerPool } from "../src/worker/worker-pool.ts";

describe("PiThreadsService config defaults", () => {
  it("applies default model and thinking when starting a new thread", async () => {
    const worker = new FakeWorker();
    const service = serviceWithWorker(worker, {
      defaults: { model: "mock/default", thinking: "high" },
    });

    await service.threadStart({ cwd: "/tmp/project" });

    expect(worker.commands).toContainEqual({
      type: "set_model",
      provider: "mock",
      modelId: "default",
    });
    expect(worker.commands).toContainEqual({ type: "set_thinking_level", level: "high" });
  });

  it("lets explicit new-thread settings override config defaults", async () => {
    const worker = new FakeWorker();
    const service = serviceWithWorker(worker, {
      defaults: { model: "mock/default", thinking: "high" },
    });

    await service.threadStart({
      cwd: "/tmp/project",
      model: "mock/explicit",
      thinking: "low",
    });

    expect(worker.commands).toContainEqual({
      type: "set_model",
      provider: "mock",
      modelId: "explicit",
    });
    expect(worker.commands).toContainEqual({ type: "set_thinking_level", level: "low" });
    expect(worker.commands).not.toContainEqual({
      type: "set_model",
      provider: "mock",
      modelId: "default",
    });
  });

  it("resolves provider-prefixed model names through the Pi catalog", async () => {
    const worker = new FakeWorker([
      {
        provider: "work-gpt-oss-120b",
        id: "/models/gpt-oss-120b",
        name: "gpt-oss-120b",
      },
    ]);
    const service = serviceWithWorker(worker, {});

    await service.threadStart({
      cwd: "/tmp/project",
      model: "work-gpt-oss-120b/gpt-oss-120b",
    });

    expect(worker.commands).toContainEqual({
      type: "set_model",
      provider: "work-gpt-oss-120b",
      modelId: "/models/gpt-oss-120b",
    });
  });

  it("does not reapply new-thread defaults to existing-thread sends", async () => {
    const worker = new FakeWorker();
    const service = serviceWithWorker(worker, {
      defaults: { model: "mock/default", thinking: "high" },
    });

    await service.threadSend({ threadId: "thread-1", prompt: "continue" });

    expect(worker.commands).not.toContainEqual({
      type: "set_model",
      provider: "mock",
      modelId: "default",
    });
    expect(worker.commands).not.toContainEqual({ type: "set_thinking_level", level: "high" });
    expect(worker.commands).toContainEqual({ type: "prompt", message: "continue" });
  });

  it("does not let extension UI responses override Pi RPC envelope fields", async () => {
    const worker = new FakeWorker();
    const service = serviceWithWorker(worker, {});

    await service.threadExtensionUiRespond({
      threadId: "thread-1",
      requestId: "request-1",
      response: { id: "attacker-id", type: "wrong_type", selected: "ok" },
    });

    expect(worker.rawMessages).toEqual([
      { id: "request-1", type: "extension_ui_response", selected: "ok" },
    ]);
  });
});

function serviceWithWorker(
  worker: FakeWorker,
  override: Partial<PiThreadsConfig>,
): PiThreadsService {
  return new PiThreadsService(
    { ...defaultConfig(), ...override },
    {
      catalog: {
        resolveThread: async () => ({
          id: "thread-1",
          path: "/tmp/project/session.jsonl",
          cwd: "/tmp/project",
          created: new Date(),
          modified: new Date(),
          messageCount: 0,
          firstMessage: "",
          allMessagesText: "",
        }),
        assertUnchanged: () => undefined,
        updateFromWorkerState: () => undefined,
      } as unknown as PiSessionCatalog,
      workers: {
        acquireForNew: async () => worker,
        acquireForSession: async () => worker,
        release: () => undefined,
        findByThread: () => undefined,
        read: () => worker,
        list: () => [],
      } as unknown as WorkerPool,
    },
  );
}

class FakeWorker implements PooledWorker {
  constructor(private readonly availableModels: Array<Record<string, unknown>> = []) {}

  readonly workerId = "worker-1";
  readonly cwd = "/tmp/project";
  readonly startedAt = new Date();
  version = "0.75.5";
  state: PooledWorker["state"] = "idle";
  threadId: string | undefined;
  activeTurnId: string | undefined;
  lastUsedAt = new Date();
  pid = 123;
  readonly commands: Record<string, unknown>[] = [];
  readonly rawMessages: unknown[] = [];

  async start(): Promise<void> {}

  async command(command: Record<string, unknown>) {
    this.commands.push(command);
    if (command.type === "get_available_models") {
      return {
        type: "response" as const,
        command: String(command.type),
        success: true,
        data: { models: this.availableModels },
      };
    }
    return { type: "response" as const, command: String(command.type), success: true };
  }

  async getState(): Promise<Record<string, unknown>> {
    return { sessionId: "thread-1", sessionFile: "/tmp/project/session.jsonl" };
  }

  sendRaw(value: unknown): void {
    this.rawMessages.push(value);
  }

  async stop(): Promise<void> {}

  on(): this {
    return this;
  }
}
