import { Command, Option } from "commander";
import { THINKING_LEVELS } from "../config.ts";
import { VERSION } from "../version.ts";
import { configureCompletionCommands } from "./completion.ts";
import { CliRuntime, type GlobalOptions } from "./runtime.ts";

export async function runCli(argv = process.argv): Promise<void> {
  const program = new Command();
  const runtime = new CliRuntime(() => program.opts<GlobalOptions>());
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
    .option("--tls-ca <path>");

  configureCompletionCommands(program);

  const daemon = program.command("daemon");
  daemon
    .command("start")
    .option("--stdio")
    .action(async (options: { stdio?: boolean }) => runtime.daemonStart(options));
  daemon
    .command("status")
    .action(async () => runtime.render(await runtime.request("server/status")));
  daemon
    .command("stop")
    .action(async () => runtime.render(await runtime.request("server/shutdown")));

  const servers = program.command("servers");
  servers.action(() => runtime.render(runtime.servers()));
  servers
    .command("ping")
    .action(async () => runtime.render(await runtime.request("server/status")));

  program
    .command("list")
    .option("--cwd <path>")
    .option("--limit <n>")
    .option("--cursor <cursor>")
    .option("--since <value>")
    .option("--archived")
    .addOption(new Option("--sort <key>").choices(["updated", "created"]))
    .option("--asc")
    .option("--desc")
    .action(async (options) =>
      runtime.render(
        await runtime.request("thread/list", {
          cwd: options.cwd,
          limit: numberOpt(options.limit),
          cursor: options.cursor,
          since: options.since,
          archived: options.archived,
          sort: options.sort,
          asc: sortAscending(options),
        }),
      ),
    );

  program
    .command("search")
    .argument("<query>")
    .option("--cwd <path>")
    .option("--limit <n>")
    .option("--cursor <cursor>")
    .option("--since <value>")
    .option("--archived")
    .addOption(new Option("--sort <key>").choices(["updated", "created"]))
    .option("--asc")
    .option("--desc")
    .action(async (query, options) =>
      runtime.render(
        await runtime.request("thread/search", {
          query,
          cwd: options.cwd,
          limit: numberOpt(options.limit),
          cursor: options.cursor,
          since: options.since,
          archived: options.archived,
          sort: options.sort,
          asc: sortAscending(options),
        }),
      ),
    );

  program
    .command("show")
    .argument("<threadId>")
    .option("--last <n>")
    .option("--asc")
    .option("--desc")
    .addOption(new Option("--items <mode>").choices(["summary", "full", "none"]))
    .action(async (threadId, options) =>
      runtime.showThread(threadId, {
        last: numberOpt(options.last),
        asc: sortAscending(options),
        items: options.items,
      }),
    );

  program
    .command("messages")
    .argument("<threadId>")
    .option("--last <n>")
    .option("--since <value>")
    .addOption(new Option("--role <role>").choices(["user", "assistant", "tool", "bash", "custom"]))
    .action(async (threadId, options) =>
      runtime.render(
        await runtime.request("thread/messages", {
          threadId,
          last: numberOpt(options.last),
          since: options.since,
          role: options.role,
        }),
      ),
    );

  program
    .command("new")
    .option("--cwd <path>", "working directory", process.cwd())
    .option("--name <name>")
    .option("--model <model>")
    .addOption(new Option("--thinking <level>").choices([...THINKING_LEVELS]))
    .argument("[prompt...]")
    .action(async (promptParts: string[], options) =>
      runtime.work("thread/start", {
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
    .addOption(new Option("--thinking <level>").choices([...THINKING_LEVELS]))
    .argument("<prompt...>")
    .action(async (threadId, promptParts, options) =>
      runtime.work("thread/send", {
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
      runtime.render(
        await runtime.request("thread/steer", { threadId, prompt: promptParts.join(" ") }),
      );
    });
  program
    .command("follow-up")
    .argument("<threadId>")
    .argument("<prompt...>")
    .action(async (threadId, promptParts) => {
      runtime.render(
        await runtime.request("thread/follow_up", { threadId, prompt: promptParts.join(" ") }),
      );
    });
  program
    .command("abort")
    .argument("<threadId>")
    .action(async (threadId) =>
      runtime.render(await runtime.request("thread/abort", { threadId })),
    );
  program
    .command("status")
    .argument("[threadId]")
    .action(async (threadId) =>
      runtime.render(await runtime.request("thread/status", { threadId })),
    );
  program
    .command("fork")
    .argument("<threadId>")
    .requiredOption("--entry-id <entryId>")
    .option("--name <name>")
    .action(async (threadId, options) =>
      runtime.render(
        await runtime.request("thread/fork", {
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
      runtime.render(await runtime.request("thread/clone", { threadId, name: options.name }));
    });
  program
    .command("name")
    .argument("<threadId>")
    .argument("<name>")
    .action(async (threadId, name) => {
      runtime.render(await runtime.request("thread/name/set", { threadId, name }));
    });

  const settings = program.command("settings");
  settings
    .command("show")
    .argument("<threadId>")
    .action(async (threadId) =>
      runtime.render(await runtime.request("thread/settings/read", { threadId })),
    );
  settings
    .command("set")
    .argument("<threadId>")
    .option("--model <model>")
    .addOption(new Option("--thinking <level>").choices([...THINKING_LEVELS]))
    .addOption(new Option("--steering-mode <mode>").choices(["all", "one-at-a-time"]))
    .addOption(new Option("--follow-up-mode <mode>").choices(["all", "one-at-a-time"]))
    .addOption(
      new Option("--auto-compaction <state>").choices(["on", "off", "true", "false", "1", "0"]),
    )
    .addOption(new Option("--auto-retry <state>").choices(["on", "off", "true", "false", "1", "0"]))
    .action(async (threadId, options) =>
      runtime.render(
        await runtime.request("thread/settings/update", {
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

  program
    .command("models")
    .option("--provider <provider>")
    .action(async (options) =>
      runtime.render(await runtime.request("models/list", { provider: options.provider })),
    );
  program
    .command("usage")
    .argument("[threadId]")
    .action(async (threadId) => runtime.render(await runtime.request("usage/read", { threadId })));
  program
    .command("commands")
    .argument("<threadId>")
    .action(async (threadId) =>
      runtime.render(await runtime.request("thread/commands/list", { threadId })),
    );
  program
    .command("stats")
    .argument("<threadId>")
    .action(async (threadId) =>
      runtime.render(await runtime.request("thread/context/stats", { threadId })),
    );
  program
    .command("compact")
    .argument("<threadId>")
    .argument("[prompt...]")
    .action(async (threadId, promptParts) => {
      runtime.render(
        await runtime.request("thread/compact", {
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
      runtime.render(
        await runtime.request("thread/bash/run", { threadId, command: commandParts.join(" ") }),
      );
    });
  program
    .command("export-html")
    .argument("<threadId>")
    .argument("[output]")
    .action(async (threadId, output) => runtime.exportHtml(threadId, output));

  await program.parseAsync(argv);
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

function sortAscending(options: { asc?: boolean; desc?: boolean }): boolean | undefined {
  if (options.asc) {
    return true;
  }
  if (options.desc) {
    return false;
  }
  return undefined;
}
