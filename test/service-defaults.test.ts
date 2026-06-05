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

  async start(): Promise<void> {}

  async command(command: Record<string, unknown>) {
    this.commands.push(command);
    return { type: "response" as const, command: String(command.type), success: true };
  }

  async getState(): Promise<Record<string, unknown>> {
    return { sessionId: "thread-1", sessionFile: "/tmp/project/session.jsonl" };
  }

  sendRaw(): void {}

  async stop(): Promise<void> {}

  on(): this {
    return this;
  }
}
