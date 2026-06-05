import { writeFileSync } from "node:fs";
import { DaemonClient } from "../client/daemon-client.ts";
import { loadConfig, resolveEndpoint } from "../config.ts";
import { startDaemon } from "../daemon.ts";
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
  tlsCert?: string;
  tlsKey?: string;
}

export class CliRuntime {
  constructor(private readonly readOptions: () => GlobalOptions) {}

  async daemonStart(options: { stdio?: boolean }): Promise<void> {
    const runtime = await startDaemon(this.config(), { stdio: options.stdio });
    if (!options.stdio) {
      for (const transport of runtime.transports) {
        process.stderr.write(`listening ${transport.name}\n`);
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
    const noWait = options.wait === false;
    const shouldWait = !noWait && hasPrompt(params);
    const shouldSubscribe = options.stream || shouldWait;
    const bufferedEvents: Array<Parameters<typeof renderEvent>[0]> = [];
    let accepted: { threadId?: string; turnId?: string } | undefined;
    let terminal = false;
    const handleEvent = (event: Parameters<typeof renderEvent>[0]) => {
      if (!accepted) {
        bufferedEvents.push(event);
        return;
      }
      if (!eventMatchesAccepted(event, accepted)) {
        return;
      }
      if (options.stream) {
        renderEvent(event, Boolean(options.json));
      }
      if (isTerminalTurnEvent(event.type)) {
        terminal = true;
      }
    };
    try {
      if (shouldSubscribe) {
        await client.connect();
        client.on("event", handleEvent);
        await client.request("subscribe/all", {});
      }
      accepted = (await client.request(method, params)) as { threadId?: string; turnId?: string };
      if (options.json && options.stream) {
        printNdjson(accepted);
      } else {
        this.render(accepted);
      }
      for (const event of bufferedEvents.splice(0)) {
        handleEvent(event);
      }
      if (!shouldWait) {
        return;
      }
      while (!terminal) {
        await new Promise((resolve) => setTimeout(resolve, 50));
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
      endpoint: resolveEndpoint({ config, connect: options.connect, server: options.server }),
      authToken: options.authToken,
      authTokenEnv: options.authTokenEnv,
      tlsCa: options.tlsCa,
    });
  }
}

function hasPrompt(params: Record<string, unknown>): boolean {
  return typeof params.prompt === "string" && params.prompt.trim().length > 0;
}

function eventMatchesAccepted(
  event: Parameters<typeof renderEvent>[0],
  accepted: { threadId?: string; turnId?: string },
): boolean {
  if (accepted.turnId && event.turnId) {
    return event.turnId === accepted.turnId;
  }
  if (accepted.threadId && event.threadId) {
    return event.threadId === accepted.threadId;
  }
  return false;
}

function isTerminalTurnEvent(type: string): boolean {
  return type === "turn.completed" || type === "turn.aborted" || type === "turn.failed";
}
