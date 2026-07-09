import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PI_VERSION_TIMEOUT_MS,
  PiRpcWorker,
  probePiVersion,
} from "../src/worker/pi-rpc-worker.ts";

const roots: string[] = [];
const savedEnv = {
  PI_OFFLINE: process.env.PI_OFFLINE,
  PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK,
  PI_TELEMETRY: process.env.PI_TELEMETRY,
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  restoreEnv("PI_OFFLINE", savedEnv.PI_OFFLINE);
  restoreEnv("PI_SKIP_VERSION_CHECK", savedEnv.PI_SKIP_VERSION_CHECK);
  restoreEnv("PI_TELEMETRY", savedEnv.PI_TELEMETRY);
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

  it("ignores malformed stdout lines without crashing the daemon", async () => {
    const { bin, root } = fakePiBin();
    const worker = new PiRpcWorker({ workerId: "worker_1", cwd: root, piBin: bin });
    await worker.start();

    await expect(worker.command({ type: "garbage_then_ok" }, 2_000)).resolves.toMatchObject({
      success: true,
    });
    await worker.stop();
  });

  it("runs the version probe with offline update checks and telemetry disabled", async () => {
    delete process.env.PI_OFFLINE;
    delete process.env.PI_SKIP_VERSION_CHECK;
    delete process.env.PI_TELEMETRY;
    const { bin, envPath } = fakePiBin({ recordVersionEnv: true });

    await expect(probePiVersion(bin)).resolves.toBe("0.75.5");

    expect(JSON.parse(readFileSync(envPath!, "utf8"))).toEqual({
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    });
  });

  it("uses a 15 second default pi version probe timeout", () => {
    expect(DEFAULT_PI_VERSION_TIMEOUT_MS).toBe(15_000);
  });
});

function fakePiBin(options: { recordVersionEnv?: boolean } = {}): {
  bin: string;
  envPath?: string;
  logPath: string;
  root: string;
} {
  const root = mkdtempSync(join(tmpdir(), "pi-threads-rpc-worker-"));
  roots.push(root);
  const bin = join(root, "pi");
  const logPath = join(root, "commands.log");
  const envPath = options.recordVersionEnv ? join(root, "version-env.json") : undefined;
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
const logPath = ${JSON.stringify(logPath)};
const envPath = ${JSON.stringify(envPath)};
if (process.argv.includes("--version")) {
  if (envPath) {
    fs.writeFileSync(envPath, JSON.stringify({
      PI_OFFLINE: process.env.PI_OFFLINE,
      PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK,
      PI_TELEMETRY: process.env.PI_TELEMETRY,
    }));
  }
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
    if (command.type === "garbage_then_ok") {
      process.stdout.write("this is not json\\n");
      log("end " + command.type);
      send({ id: command.id, type: "response", command: command.type, success: true });
    } else if (command.type === "slow") {
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
  return { bin, envPath, logPath, root };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
