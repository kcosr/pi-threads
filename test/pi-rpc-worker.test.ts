import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcWorker } from "../src/worker/pi-rpc-worker.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("PiRpcWorker", () => {
  it("serializes normal commands to one Pi RPC child", async () => {
    const { bin, logPath, root } = fakePiBin();
    const worker = new PiRpcWorker({ workerId: "worker_1", cwd: root, piBin: bin });
    await worker.start();

    await Promise.all([
      worker.command({ type: "slow" }, 2_000),
      worker.command({ type: "fast" }, 2_000),
    ]);
    await worker.stop();

    expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
      "start slow",
      "end slow",
      "start fast",
      "end fast",
    ]);
  });

  it("rejects malformed commands before writing to Pi RPC stdin", async () => {
    const { bin, root } = fakePiBin();
    const worker = new PiRpcWorker({ workerId: "worker_1", cwd: root, piBin: bin });
    await worker.start();

    await expect(worker.command(null as unknown as Record<string, unknown>)).rejects.toMatchObject({
      code: "invalidParams",
    });
    await expect(worker.command({ id: "client-id", type: "get_state" })).rejects.toMatchObject({
      code: "invalidParams",
    });
    expect(() => worker.sendRaw(null)).toThrow(/raw message/);
    await worker.stop();
  });
});

function fakePiBin(): { bin: string; logPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-threads-rpc-worker-"));
  roots.push(root);
  const bin = join(root, "pi");
  const logPath = join(root, "commands.log");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
const logPath = ${JSON.stringify(logPath)};
if (process.argv.includes("--version")) {
  console.log("0.75.5");
  process.exit(0);
}
if (!process.argv.includes("--mode") || !process.argv.includes("rpc")) {
  process.exit(2);
}
function log(line) {
  fs.appendFileSync(logPath, line + "\\n");
}
function send(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    log("start " + command.type);
    if (command.type === "slow") {
      setTimeout(() => {
        log("end " + command.type);
        send({ id: command.id, type: "response", command: command.type, success: true });
      }, 50);
    } else {
      log("end " + command.type);
      send({ id: command.id, type: "response", command: command.type, success: true });
    }
  }
});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, logPath, root };
}
