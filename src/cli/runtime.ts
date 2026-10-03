import { writeFileSync } from "node:fs";
import { DaemonClient } from "../client/daemon-client.ts";
import { loadConfig, resolveClientConfig } from "../config.ts";
import { startDaemon } from "../daemon.ts";
import { DaemonError } from "../errors.ts";
import { printJson, printNdjson, renderEvent, renderHuman, renderThreadRead } from "./render.ts";

export interface GlobalOptions {
  config?: string;
  connect?: string;
  server?: string;
  json?: boolean;
  stream?: boolean;
  wait?: boolean;
  authToken?: string;
  authTokenEnv?: string;
  tlsCa?: string;
}

export class CliRuntime {
  constructor(private readonly readOptions: () => GlobalOptions) {}

  async daemonStart(options: { stdio?: boolean }): Promise<void> {
    const runtime = await startDaemon(this.config(), { stdio: options.stdio });
    if (!options.stdio) {
      for (const name of runtime.transports.flatMap((transport) => transport.names)) {
        process.stderr.write(`listening ${name}\n`);
      }
    }
    const stop = async () => {
      await runtime.stop();
      process.exit(0);
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    await new Promise(() => undefined);
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const client = this.client();
    try {
      return await client.request<T>(method, params);
    } finally {
      await client.close();
    }
  }

  async work(method: string, params: Record<string, unknown>): Promise<void> {
    const options = this.readOptions();
    const client = this.client();
    const renderAcceptance = (value: unknown) => {
      if (options.json && options.stream) printNdjson(value);
      else this.render(value);
    };
    try {
      if (options.wait === false || !hasPrompt(params)) {
        renderAcceptance(await client.request(method, params));
        return;
      }
      const stream = await client.streamTurn(method, params);
      try {
        for await (const frame of stream) {
          if (frame.type === "accepted") {
            renderAcceptance(frame.result);
            continue;
          }
          const event = frame.event;
          if (options.stream) renderEvent(event, Boolean(options.json));
          if (event.type === "turn.failed" || event.type === "turn.aborted") {
            throw new DaemonError(
              "piRpcError",
              String(
                event.payload.message ??
                  (event.type === "turn.aborted" ? "Pi turn aborted" : "Pi turn failed"),
              ),
              event.payload,
            );
          }
        }
      } finally {
        await stream.close();
      }
    } finally {
      await client.close();
    }
  }

  servers(): Record<string, unknown> {
    return this.config().servers;
  }

  async showThread(
    threadId: string,
    options: { last?: number; asc?: boolean; items?: string | undefined },
  ): Promise<void> {
    const result = await this.request<Record<string, unknown>>("thread/read", {
      threadId,
      last: options.last,
      asc: options.asc,
    });
    if (this.readOptions().json) {
      printJson(result);
      return;
    }
    renderThreadRead(result, options.items);
  }

  async exportHtml(threadId: string, output: string | undefined): Promise<void> {
    const result = await this.request<{ html: string }>("thread/export/html", { threadId });
    if (output) {
      writeFileSync(output, result.html);
      this.render({ threadId, output });
      return;
    }
    if (this.readOptions().json) {
      printJson(result);
      return;
    }
    process.stdout.write(result.html);
  }

  render(value: unknown): void {
    if (this.readOptions().json) {
      printJson(value);
      return;
    }
    renderHuman(value);
  }

  private config() {
    return loadConfig(this.readOptions().config);
  }

  private client(): DaemonClient {
    const options = this.readOptions();
    const config = this.config();
    return new DaemonClient({
      ...resolveClientConfig({
        config,
        connect: options.connect,
        server: options.server,
        authToken: options.authToken,
        authTokenEnv: options.authTokenEnv,
        tlsCa: options.tlsCa,
      }),
    });
  }
}

function hasPrompt(params: Record<string, unknown>): boolean {
  return typeof params.prompt === "string" && params.prompt.trim().length > 0;
}
