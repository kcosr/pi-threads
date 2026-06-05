import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.ts";
import { PiThreadsService } from "../src/service/pi-threads-service.ts";
import type { PiSessionCatalog } from "../src/session/catalog.ts";
import type { WorkerPool } from "../src/worker/worker-pool.ts";

describe("PiThreadsService read/message filters", () => {
  it("reports catalog threads as running when their daemon worker is running", async () => {
    const service = new PiThreadsService(defaultConfig(), {
      catalog: {
        list: async () => [
          {
            threadId: "thread-1",
            cwd: "/tmp/project",
            messageCount: 1,
            status: "idle",
          },
        ],
      } as unknown as PiSessionCatalog,
      workers: {
        list: () => [
          {
            workerId: "worker-1",
            cwd: "/tmp/project",
            state: "running",
            threadId: "thread-1",
            startedAt: "2026-06-05T12:00:00Z",
            lastUsedAt: "2026-06-05T12:00:00Z",
          },
        ],
      } as unknown as WorkerPool,
    });

    const result = await service.threadList();

    expect(result.threads).toMatchObject([{ threadId: "thread-1", status: "running" }]);
  });

  it("reports assigned workers as idle thread status", async () => {
    const service = new PiThreadsService(defaultConfig(), {
      catalog: {
        list: async () => [
          {
            threadId: "thread-1",
            cwd: "/tmp/project",
            messageCount: 1,
            status: "idle",
          },
        ],
      } as unknown as PiSessionCatalog,
      workers: {
        list: () => [
          {
            workerId: "worker-1",
            cwd: "/tmp/project",
            state: "assigned",
            threadId: "thread-1",
            startedAt: "2026-06-05T12:00:00Z",
            lastUsedAt: "2026-06-05T12:00:00Z",
          },
        ],
      } as unknown as WorkerPool,
    });

    const result = await service.threadList();

    expect(result.threads).toMatchObject([{ threadId: "thread-1", status: "idle" }]);
  });

  it("filters, sorts, and pages thread lists after worker status overlay", async () => {
    const service = serviceWithCatalog({
      list: async () => [
        thread("old", "2026-06-05T10:00:00Z", "2026-06-05T10:30:00Z"),
        thread("new", "2026-06-05T11:00:00Z", "2026-06-05T12:30:00Z"),
        thread("mid", "2026-06-05T11:30:00Z", "2026-06-05T12:00:00Z"),
      ],
    });

    const result = await service.threadList({
      since: "2026-06-05T11:00:00Z",
      sort: "created",
      asc: true,
      limit: 1,
      cursor: "1",
    });

    expect(result.threads.map((item) => item.threadId)).toEqual(["mid"]);
    expect(result.cursor).toBeUndefined();
  });

  it("searches before applying list filters and limit", async () => {
    const service = serviceWithCatalog({
      search: async () => [
        { ...thread("old-match", "2026-06-05T10:00:00Z", "2026-06-05T10:30:00Z"), name: "match" },
        { ...thread("new-match", "2026-06-05T11:00:00Z", "2026-06-05T12:30:00Z"), name: "match" },
      ],
    });

    const result = await service.threadSearch({
      query: "match",
      since: "2026-06-05T12:00:00Z",
      limit: 1,
    });

    expect(result.threads.map((item) => item.threadId)).toEqual(["new-match"]);
  });

  it("rejects archive filtering because pi-threads has no archive store", async () => {
    const service = serviceWithCatalog({ list: async () => [] });

    await expect(service.threadList({ archived: true })).rejects.toMatchObject({
      code: "invalidParams",
    });
  });

  it("limits show entries to the last N message entries", async () => {
    const service = serviceWithCatalog({
      read: async () => ({
        thread: {
          threadId: "thread-1",
          cwd: "/tmp/project",
          messageCount: 3,
          status: "idle",
        },
        entries: [
          {
            id: "entry-1",
            parentId: null,
            timestamp: "2026-06-05T12:00:00Z",
            type: "message",
            message: { role: "user", content: "one", timestamp: 1_780_681_600_000 },
          },
          {
            id: "entry-2",
            parentId: "entry-1",
            timestamp: "2026-06-05T12:00:30Z",
            type: "custom",
            customType: "ignored",
          },
          {
            id: "entry-3",
            parentId: "entry-2",
            timestamp: "2026-06-05T12:01:00Z",
            type: "message",
            message: { role: "assistant", content: "two", timestamp: 1_780_681_660_000 },
          },
        ],
      }),
    });

    const result = await service.threadRead({ threadId: "thread-1", last: 1 });

    expect(result.entries).toEqual([
      {
        id: "entry-3",
        parentId: "entry-2",
        timestamp: "2026-06-05T12:01:00Z",
        type: "message",
        message: { role: "assistant", content: "two", timestamp: 1_780_681_660_000 },
      },
    ]);
  });

  it("filters messages by role, since, and last", async () => {
    const service = serviceWithCatalog({
      messages: async () => ({
        threadId: "thread-1",
        messages: [
          { role: "user", createdAt: "2026-06-05T12:00:00Z", content: "old user" },
          { role: "assistant", createdAt: "2026-06-05T12:01:00Z", content: "old assistant" },
          { role: "assistant", createdAt: "2026-06-05T12:02:00Z", content: "new assistant" },
        ],
      }),
    });

    const result = await service.threadMessages({
      threadId: "thread-1",
      role: "assistant",
      since: "2026-06-05T12:01:30Z",
      last: 1,
    });

    expect(result.messages).toEqual([
      { role: "assistant", createdAt: "2026-06-05T12:02:00Z", content: "new assistant" },
    ]);
  });

  it("maps user-facing tool and bash role filters to Pi message roles", async () => {
    const service = serviceWithCatalog({
      messages: async () => ({
        threadId: "thread-1",
        messages: [
          { role: "toolResult", timestamp: 1_780_681_600_000, content: "tool output" },
          { role: "bashExecution", timestamp: 1_780_681_601_000, command: "pwd" },
          { role: "assistant", timestamp: 1_780_681_602_000, content: "assistant" },
        ],
      }),
    });

    await expect(service.threadMessages({ threadId: "thread-1", role: "tool" })).resolves.toEqual({
      threadId: "thread-1",
      messages: [{ role: "toolResult", timestamp: 1_780_681_600_000, content: "tool output" }],
    });
    await expect(service.threadMessages({ threadId: "thread-1", role: "bash" })).resolves.toEqual({
      threadId: "thread-1",
      messages: [{ role: "bashExecution", timestamp: 1_780_681_601_000, command: "pwd" }],
    });
  });
});

function serviceWithCatalog(catalog: Record<string, unknown>): PiThreadsService {
  return new PiThreadsService(defaultConfig(), {
    catalog: catalog as unknown as PiSessionCatalog,
    workers: {
      findByThread: () => undefined,
      list: () => [],
    } as unknown as WorkerPool,
  });
}

function thread(threadId: string, created: string, modified: string) {
  return {
    threadId,
    cwd: "/tmp/project",
    created,
    modified,
    messageCount: 1,
    status: "idle" as const,
  };
}
