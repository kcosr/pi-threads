import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiSessionCatalog } from "../src/session/catalog.ts";

describe("PiSessionCatalog", () => {
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;

  afterEach(() => {
    if (previousSessionDir === undefined) {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    } else {
      process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    }
  });

  it("reads sessions from an explicit Pi session directory without importing Pi runtime", async () => {
    const root = join(tmpdir(), `pi-threads-session-catalog-${Date.now()}`);
    const cwd = join(root, "workspace");
    const sessionDir = join(root, "sessions");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;

    const sessionPath = join(sessionDir, "2026-07-03T00-00-00-000Z_thread-1.jsonl");
    writeFileSync(
      sessionPath,
      [
        {
          type: "session",
          version: 3,
          id: "thread-1",
          timestamp: "2026-07-03T00:00:00.000Z",
          cwd,
        },
        {
          type: "session_info",
          id: "info",
          parentId: null,
          timestamp: "2026-07-03T00:00:01.000Z",
          name: "catalog smoke",
        },
        {
          type: "message",
          id: "user",
          parentId: "info",
          timestamp: "2026-07-03T00:00:02.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "Say exactly: ok" }],
            timestamp: Date.parse("2026-07-03T00:00:02.000Z"),
          },
        },
        {
          type: "message",
          id: "assistant",
          parentId: "user",
          timestamp: "2026-07-03T00:00:03.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            timestamp: Date.parse("2026-07-03T00:00:03.000Z"),
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    writeFileSync(
      join(sessionDir, "2026-07-03T00-00-04-000Z_thread-without-cwd.jsonl"),
      [
        {
          type: "session",
          version: 3,
          id: "thread-without-cwd",
          timestamp: "2026-07-03T00:00:04.000Z",
          cwd: "",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );

    const catalog = new PiSessionCatalog();
    const threads = await catalog.list(cwd);
    const allThreads = await catalog.list();
    const read = await catalog.read("thread-1");
    const messages = await catalog.messages("thread-1", { role: "assistant" });

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      threadId: "thread-1",
      path: sessionPath,
      cwd,
      name: "catalog smoke",
      messageCount: 2,
      firstMessage: "Say exactly: ok",
    });
    expect(allThreads.map((thread) => thread.threadId)).toEqual([
      "thread-without-cwd",
      "thread-1",
    ]);
    expect(read.entries.map((entry) => entry.type)).toEqual([
      "session_info",
      "message",
      "message",
    ]);
    expect(messages.messages).toMatchObject([{ role: "assistant" }]);

    rmSync(root, { recursive: true, force: true });
  });
});
