import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonError } from "../errors.ts";
import { isSupportedPiVersion } from "../version.ts";

export type WorkerProcessState =
  | "starting"
  | "idle"
  | "assigned"
  | "running"
  | "crashed"
  | "stopped";

export interface PiRpcWorkerOptions {
  workerId: string;
  cwd: string;
  piBin?: string;
  versionTimeoutMs?: number;
}

export interface PiRpcResponse {
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export class PiRpcWorker extends EventEmitter {
  readonly workerId: string;
  readonly cwd: string;
  readonly startedAt = new Date();
  version: string | undefined;
  state: WorkerProcessState = "starting";
  threadId: string | undefined;
  activeTurnId: string | undefined;
  lastUsedAt = new Date();
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private nextCommandId = 1;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: PiRpcResponse) => void;
      reject: (error: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(private readonly options: PiRpcWorkerOptions) {
    super();
    this.workerId = options.workerId;
    this.cwd = options.cwd;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    this.version = await probePiVersion(this.options.piBin, this.options.versionTimeoutMs ?? 5_000);
    if (!isSupportedPiVersion(this.version)) {
      throw new DaemonError("piRpcError", "Unsupported pi version", {
        version: this.version,
        supported: "0.75.x",
      });
    }
    const piBin = this.options.piBin ?? process.env.PI_THREADS_PI_BIN ?? "pi";
    this.child = spawn(piBin, ["--mode", "rpc"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_OFFLINE: process.env.PI_OFFLINE ?? "1" },
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString("utf8")));
    this.child.on("exit", (exitCode, signal) => {
      const wasStopped = this.state === "stopped";
      this.state = wasStopped ? "stopped" : "crashed";
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new DaemonError("workerCrashed", "Pi RPC worker exited", { exitCode, signal }),
        );
      }
      this.pending.clear();
      this.emit("exit", { exitCode, signal });
    });
    this.state = "idle";
  }

  async command(command: Record<string, unknown>, timeoutMs = 60_000): Promise<PiRpcResponse> {
    if (!this.child || this.state === "crashed" || this.state === "stopped") {
      throw new DaemonError("workerCrashed", "Worker is not running", { workerId: this.workerId });
    }
    const id = `rpc_${this.nextCommandId++}`;
    const payload = { id, ...command };
    const response = await new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DaemonError("timeout", "Pi RPC command timed out", { command: command.type }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify(payload)}\n`);
    });
    if (!response.success) {
      throw new DaemonError("piRpcError", response.error ?? "Pi RPC command failed", {
        command: response.command,
      });
    }
    this.lastUsedAt = new Date();
    return response;
  }

  sendRaw(value: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async getState(): Promise<Record<string, unknown>> {
    const response = await this.command({ type: "get_state" }, 20_000);
    return (response.data ?? {}) as Record<string, unknown>;
  }

  async stop(timeoutMs = 2_000): Promise<void> {
    if (!this.child || this.state === "stopped") {
      return;
    }
    this.state = "stopped";
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    await delay(timeoutMs);
    if (!this.child.killed) {
      this.child.kill("SIGKILL");
    }
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index === -1) {
        return;
      }
      const rawLine = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!rawLine) {
        continue;
      }
      const parsed = JSON.parse(rawLine) as Record<string, unknown>;
      if (parsed.type === "response" && typeof parsed.id === "string") {
        const pending = this.pending.get(parsed.id);
        if (pending) {
          this.pending.delete(parsed.id);
          clearTimeout(pending.timer);
          pending.resolve(parsed as unknown as PiRpcResponse);
        }
      } else {
        this.emit("event", parsed);
      }
    }
  }
}

export async function probePiVersion(piBin?: string, timeoutMs = 5_000): Promise<string> {
  const command = piBin ?? process.env.PI_THREADS_PI_BIN ?? "pi";
  const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    errorOutput += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  if (exitCode !== 0) {
    throw new DaemonError("piRpcError", "Unable to run pi --version", { exitCode });
  }
  return (output || errorOutput).trim();
}
