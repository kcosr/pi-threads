import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { loadConfig, resolveEndpoint } from "../config.ts";
import { DaemonClient } from "../client/daemon-client.ts";
import { startDaemon } from "../daemon.ts";
import { VERSION } from "../version.ts";
import { printJson, renderEvent, renderHuman } from "./render.ts";

interface GlobalOptions {
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

export async function runCli(argv = process.argv): Promise<void> {
  const program = new Command();
  program
    .name("pi-threads")
    .version(VERSION)
    .option("--config <path>")
    .option("--connect <endpoint>")
    .option("--server <alias>")
    .option("--json")
    .option("--stream")
    .option("--no-wait")
    .option("--auth-token <token>")
    .option("--auth-token-env <env>")
    .option("--tls-ca <path>")
    .option("--tls-cert <path>")
    .option("--tls-key <path>");

  const daemon = program.command("daemon");
  daemon
    .command("start")
    .option("--stdio")
    .action(async (options) => {
      const config = loadConfig(program.opts<GlobalOptions>().config);
      const runtime = await startDaemon(config, { stdio: options.stdio });
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
    });
  daemon.command("status").action(async () => render(await request(program, "server/status")));
  daemon.command("stop").action(async () => render(await request(program, "server/shutdown")));

  program
    .command("servers")
    .argument("[ping]")
    .action(async (subcommand) => {
      if (subcommand === "ping") {
        render(await request(program, "server/status"));
        return;
      }
      const config = loadConfig(program.opts<GlobalOptions>().config);
      render(config.servers);
    });

  program
    .command("list")
    .option("--cwd <path>")
    .option("--limit <n>")
    .option("--cursor <cursor>")
    .action(async (options) =>
      render(
        await request(program, "thread/list", {
          cwd: options.cwd,
          limit: numberOpt(options.limit),
          cursor: options.cursor,
        }),
      ),
    );

  program
    .command("search")
    .argument("<query>")
    .option("--cwd <path>")
    .option("--limit <n>")
    .action(async (query, options) =>
      render(
        await request(program, "thread/search", {
          query,
          cwd: options.cwd,
          limit: numberOpt(options.limit),
        }),
      ),
    );

  program
    .command("show")
    .argument("<threadId>")
    .option("--last <n>")
    .option("--items <mode>")
    .action(async (threadId) => render(await request(program, "thread/read", { threadId })));

  program
    .command("messages")
    .argument("<threadId>")
    .option("--last <n>")
    .option("--since <value>")
    .option("--role <role>")
    .action(async (threadId, options) =>
      render(
        await request(program, "thread/messages", {
          threadId,
          last: numberOpt(options.last),
          role: options.role,
        }),
      ),
    );

  program
    .command("new")
    .option("--cwd <path>", "working directory", process.cwd())
    .option("--name <name>")
    .option("--model <model>")
    .option("--thinking <level>")
    .argument("[prompt...]")
    .action(async (promptParts: string[], options) =>
      work(program, "thread/start", {
        cwd: options.cwd,
        name: options.name,
        model: options.model,
        thinking: options.thinking,
        prompt: promptParts.join(" ") || undefined,
      }),
    );

  program
    .command("send")
    .argument("<threadId>")
    .option("--model <model>")
    .option("--thinking <level>")
    .argument("<prompt...>")
    .action(async (threadId, promptParts, options) =>
      work(program, "thread/send", {
        threadId,
        model: options.model,
        thinking: options.thinking,
        prompt: promptParts.join(" "),
      }),
    );

  program
    .command("steer")
    .argument("<threadId>")
    .argument("<prompt...>")
    .action(async (threadId, promptParts) => {
      render(await request(program, "thread/steer", { threadId, prompt: promptParts.join(" ") }));
    });
  program
    .command("follow-up")
    .argument("<threadId>")
    .argument("<prompt...>")
    .action(async (threadId, promptParts) => {
      render(
        await request(program, "thread/follow_up", { threadId, prompt: promptParts.join(" ") }),
      );
    });
  program
    .command("abort")
    .argument("<threadId>")
    .action(async (threadId) => render(await request(program, "thread/abort", { threadId })));
  program
    .command("status")
    .argument("[threadId]")
    .action(async (threadId) => render(await request(program, "thread/status", { threadId })));
  program
    .command("fork")
    .argument("<threadId>")
    .requiredOption("--entry-id <entryId>")
    .option("--name <name>")
    .action(async (threadId, options) =>
      render(
        await request(program, "thread/fork", {
          threadId,
          entryId: options.entryId,
          name: options.name,
        }),
      ),
    );
  program
    .command("clone")
    .argument("<threadId>")
    .option("--name <name>")
    .action(async (threadId, options) => {
      render(await request(program, "thread/clone", { threadId, name: options.name }));
    });
  program
    .command("name")
    .argument("<threadId>")
    .argument("<name>")
    .action(async (threadId, name) => {
      render(await request(program, "thread/name/set", { threadId, name }));
    });

  const settings = program.command("settings");
  settings
    .command("show")
    .argument("<threadId>")
    .action(async (threadId) =>
      render(await request(program, "thread/settings/read", { threadId })),
    );
  settings
    .command("set")
    .argument("<threadId>")
    .option("--model <model>")
    .option("--thinking <level>")
    .option("--steering-mode <mode>")
    .option("--follow-up-mode <mode>")
    .option("--auto-compaction <state>")
    .option("--auto-retry <state>")
    .action(async (threadId, options) =>
      render(
        await request(program, "thread/settings/update", {
          threadId,
          model: options.model,
          thinking: options.thinking,
          steeringMode: options.steeringMode,
          followUpMode: options.followUpMode,
          autoCompaction: boolOpt(options.autoCompaction),
          autoRetry: boolOpt(options.autoRetry),
        }),
      ),
    );

  program.command("models").action(async () => render(await request(program, "models/list")));
  program
    .command("usage")
    .argument("[threadId]")
    .action(async (threadId) => render(await request(program, "usage/read", { threadId })));
  program
    .command("commands")
    .argument("<threadId>")
    .action(async (threadId) =>
      render(await request(program, "thread/commands/list", { threadId })),
    );
  program
    .command("stats")
    .argument("<threadId>")
    .action(async (threadId) =>
      render(await request(program, "thread/context/stats", { threadId })),
    );
  program
    .command("compact")
    .argument("<threadId>")
    .argument("[prompt...]")
    .action(async (threadId, promptParts) => {
      render(
        await request(program, "thread/compact", {
          threadId,
          prompt: promptParts.join(" ") || undefined,
        }),
      );
    });
  program
    .command("bash")
    .argument("<threadId>")
    .argument("<command...>")
    .action(async (threadId, commandParts) => {
      render(
        await request(program, "thread/bash/run", { threadId, command: commandParts.join(" ") }),
      );
    });
  program
    .command("export-html")
    .argument("<threadId>")
    .argument("[output]")
    .action(async (threadId, output) => {
      const result = (await request(program, "thread/export/html", { threadId })) as {
        html: string;
      };
      if (output) {
        writeFileSync(output, result.html);
        render({ threadId, output });
      } else if (program.opts<GlobalOptions>().json) {
        printJson(result);
      } else {
        process.stdout.write(result.html);
      }
    });

  await program.parseAsync(argv);
}

async function request(
  program: Command,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const options = program.opts<GlobalOptions>();
  const config = loadConfig(options.config);
  const client = new DaemonClient({
    endpoint: resolveEndpoint({ config, connect: options.connect, server: options.server }),
    authToken: options.authToken,
    authTokenEnv: options.authTokenEnv,
    tlsCa: options.tlsCa,
  });
  try {
    return await client.request(method, params);
  } finally {
    await client.close();
  }
}

async function work(
  program: Command,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  const options = program.opts<GlobalOptions>();
  const config = loadConfig(options.config);
  const client = new DaemonClient({
    endpoint: resolveEndpoint({ config, connect: options.connect, server: options.server }),
    authToken: options.authToken,
    authTokenEnv: options.authTokenEnv,
    tlsCa: options.tlsCa,
  });
  const noWait = options.wait === false;
  const shouldStream = options.stream || (!noWait && !params.promptless);
  let terminal = false;
  if (shouldStream) {
    await client.connect();
    client.on("event", (event) => {
      renderEvent(event, Boolean(options.json));
      if (
        event.type === "turn.completed" ||
        event.type === "turn.aborted" ||
        event.type === "turn.failed"
      ) {
        terminal = true;
      }
    });
    await client.request("subscribe/all", {});
  }
  const accepted = await client.request(method, params);
  render(accepted);
  if (noWait || !shouldStream) {
    await client.close();
    return;
  }
  while (!terminal) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await client.close();
}

function render(value: unknown): void {
  if (process.argv.includes("--json")) {
    printJson(value);
  } else {
    renderHuman(value);
  }
}

function numberOpt(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function boolOpt(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === "on" || value === "true" || value === "1";
}
