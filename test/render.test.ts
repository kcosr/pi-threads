import { afterEach, describe, expect, it } from "vitest";
import { renderHuman, renderThreadRead } from "../src/cli/render.ts";

const originalWrite = process.stdout.write;

afterEach(() => {
  process.stdout.write = originalWrite;
});

describe("CLI human rendering", () => {
  it("renders thread lists as padded tables with headers", () => {
    const output = captureStdout(() => {
      renderHuman({
        threads: [
          {
            threadId: "thread-1",
            status: "idle",
            cwd: "/tmp/project",
            name: "Demo",
            messageCount: 2,
            modified: "2026-06-05T12:00:00Z",
          },
        ],
      });
    });

    expect(output).toContain("THREAD    STATUS");
    expect(output).toContain("thread-1  idle");
    expect(output).not.toContain("\t");
  });

  it("renders worker lists as padded tables with headers", () => {
    const output = captureStdout(() => {
      renderHuman({
        workers: [
          {
            workerId: "worker-1",
            state: "busy",
            threadId: "thread-1",
            cwd: "/tmp/project",
            pid: 123,
            version: "0.1.0",
            lastUsedAt: "2026-06-05T12:00:00Z",
          },
        ],
      });
    });

    expect(output).toContain("WORKER    STATE");
    expect(output).toContain("worker-1  busy");
    expect(output).not.toContain("\t");
  });

  it("renders generic objects as aligned key-values", () => {
    const output = captureStdout(() => {
      renderHuman({ status: "ok", activeWorkers: 2 });
    });

    expect(output).toContain("status         ok\n");
    expect(output).toContain("activeWorkers  2\n");
    expect(output).not.toContain("\t");
  });

  it("renders thread details with message items", () => {
    const output = captureStdout(() => {
      renderThreadRead({
        thread: { threadId: "thread-1", cwd: "/tmp/project", messageCount: 1, status: "idle" },
        entries: [
          {
            type: "message",
            timestamp: "2026-06-05T12:00:00Z",
            message: { role: "assistant", content: "Done." },
          },
        ],
      });
    });

    expect(output).toContain("threadId      thread-1\n");
    expect(output).toContain("[assistant 2026-06-05T12:00:00Z]\nDone.\n");
  });
});

function captureStdout(callback: () => void): string {
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  callback();
  return output;
}
