import { basename } from "node:path";
import { Argument, type Command, Option } from "commander";
import { serverNameCandidates } from "../config.ts";

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

type CompletionShell = (typeof COMPLETION_SHELLS)[number];

const hiddenCommands = new WeakSet<Command>();

export function configureCompletionCommands(root: Command): void {
  const completion = root
    .command("completion")
    .description("Print shell completion setup instructions.")
    .addArgument(shellArgument("[shell]", "shell to configure: bash, zsh, or fish"));

  completion.action((shell) => {
    process.stdout.write(completionInstructions(normalizeShell(shell)));
  });

  const script = completion
    .command("script")
    .description("Print a shell completion script.")
    .addArgument(shellArgument("<shell>", "shell script to print: bash, zsh, or fish"));

  script.action((shell) => {
    process.stdout.write(completionScript(normalizeShell(shell)));
  });

  const hiddenComplete = root
    .command("__complete", { hidden: true })
    .allowUnknownOption()
    .argument("<prefix>", "current word prefix")
    .argument("[words...]", "completed words before the current prefix");

  hiddenComplete.action(async (prefix, words: string[]) => {
    process.stdout.write(await completionCandidates(root, prefix, words));
  });
  hiddenCommands.add(hiddenComplete);
}

export async function completionCandidates(
  root: Command,
  prefix: string,
  words: string[],
): Promise<string> {
  const candidates = await resolveCompletionCandidates(root, prefix, words);
  const matches = candidates.filter((candidate) => candidate.startsWith(prefix));
  return matches.length > 0 ? `${matches.join("\n")}\n` : "";
}

function shellArgument(flags: string, description: string): Argument {
  return new Argument(flags, description).choices(COMPLETION_SHELLS);
}

async function resolveCompletionCandidates(
  root: Command,
  prefix: string,
  words: string[],
): Promise<string[]> {
  const context = completionContext(root, words);
  const equalsValue = optionValuePrefix(context.command, root, prefix);
  if (equalsValue) {
    const values = await valueCandidates(equalsValue.option, context.optionValues);
    return values.map((value) => `${equalsValue.flag}=${value}`);
  }

  if (context.pendingOption) {
    return valueCandidates(context.pendingOption, context.optionValues);
  }

  if (prefix.startsWith("-")) {
    return optionCandidates(context.command, root);
  }

  const candidates: string[] = [];
  if (context.operands.length === 0) {
    candidates.push(...subcommandCandidates(context.command));
  }

  const argument = context.command.registeredArguments[context.operands.length];
  if (argument) {
    candidates.push(...(await valueCandidates(argument, context.optionValues)));
  }

  const appCandidates = unique(candidates);
  return appCandidates.length > 0 ? appCandidates : optionCandidates(context.command, root);
}

function completionContext(
  root: Command,
  words: string[],
): {
  readonly command: Command;
  readonly operands: string[];
  readonly optionValues: Map<string, string[]>;
  readonly pendingOption?: Option;
} {
  let command = root;
  const operands: string[] = [];
  const optionValues = new Map<string, string[]>();
  let pendingOption: Option | undefined;

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined) {
      continue;
    }
    if (pendingOption) {
      recordOptionValue(optionValues, pendingOption, word);
      pendingOption = undefined;
      continue;
    }
    if (word === "--") {
      operands.push(...words.slice(index + 1));
      break;
    }
    if (operands.length === 0) {
      const subcommand = visibleSubcommand(command, word);
      if (subcommand) {
        command = subcommand;
        continue;
      }
    }
    const option = optionForToken(command, root, word);
    if (option) {
      if ((option.required || option.optional) && word.includes("=")) {
        recordOptionValue(optionValues, option, word.slice(word.indexOf("=") + 1));
      }
      if ((option.required || option.optional) && !word.includes("=")) {
        pendingOption = option;
      }
      continue;
    }
    operands.push(word);
  }

  return { command, operands, optionValues, pendingOption };
}

function optionValuePrefix(
  command: Command,
  root: Command,
  prefix: string,
): { readonly flag: string; readonly option: Option; readonly valuePrefix: string } | undefined {
  if (!prefix.startsWith("--") || !prefix.includes("=")) {
    return undefined;
  }
  const index = prefix.indexOf("=");
  const flag = prefix.slice(0, index);
  const option = optionsForCommand(command, root).find((candidate) => candidate.long === flag);
  if (!option || (!option.required && !option.optional)) {
    return undefined;
  }
  return { flag, option, valuePrefix: prefix.slice(index + 1) };
}

function optionForToken(command: Command, root: Command, token: string): Option | undefined {
  if (!token.startsWith("-")) {
    return undefined;
  }
  const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
  return optionsForCommand(command, root).find(
    (option) => option.long === flag || option.short === flag,
  );
}

async function valueCandidates(
  target: Option | Argument,
  optionValues: Map<string, string[]>,
): Promise<string[]> {
  if (target.argChoices) {
    return [...target.argChoices];
  }
  if (target instanceof Option && target.long === "--server") {
    if (latestOptionValue(optionValues, "--connect")) {
      return [];
    }
    return safeServerCandidates(latestOptionValue(optionValues, "--config"));
  }
  return [];
}

function recordOptionValue(values: Map<string, string[]>, option: Option, value: string): void {
  if (option.long) {
    values.set(option.long, [...(values.get(option.long) ?? []), value]);
  }
}

function latestOptionValue(values: Map<string, string[]>, flag: string): string | undefined {
  return values.get(flag)?.at(-1);
}

async function safeServerCandidates(configPath: string | undefined): Promise<string[]> {
  try {
    return serverNameCandidates(configPath);
  } catch {
    return [];
  }
}

function optionCandidates(command: Command, root: Command): string[] {
  return unique(
    optionsForCommand(command, root)
      .filter((option) => !option.hidden)
      .map((option) => option.long)
      .filter((option): option is string => typeof option === "string"),
  );
}

function optionsForCommand(command: Command, root: Command): Option[] {
  return command === root ? [...command.options] : [...command.options, ...root.options];
}

function subcommandCandidates(command: Command): string[] {
  return command.commands
    .filter((candidate) => !hiddenCommands.has(candidate))
    .map((candidate) => candidate.name());
}

function visibleSubcommand(command: Command, name: string): Command | undefined {
  return command.commands.find(
    (candidate) => !hiddenCommands.has(candidate) && candidate.name() === name,
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeShell(value: unknown): CompletionShell {
  if (value === "bash" || value === "zsh" || value === "fish") {
    return value;
  }
  if (value === undefined) {
    const detected = basename(process.env.SHELL ?? "");
    if (detected === "bash" || detected === "zsh" || detected === "fish") {
      return detected;
    }
    throw new Error(
      `could not detect shell from SHELL=${detected || "(unset)"}; pass bash, zsh, or fish`,
    );
  }
  throw new Error(`unsupported shell: ${String(value)}; expected bash, zsh, or fish`);
}

function completionInstructions(shell: CompletionShell): string {
  const currentShellCommand =
    shell === "fish"
      ? "pi-threads completion script fish | source"
      : `source <(pi-threads completion script ${shell})`;
  return [
    `Detected shell: ${shell}`,
    "",
    "For this shell only:",
    `  ${currentShellCommand}`,
    "",
    "To enable permanently, generate a completion file once:",
    ...permanentCompletionCommands(shell).map((command) => `  ${command}`),
    "",
    "Regenerate that file after upgrading pi-threads.",
    "",
  ].join("\n");
}

function permanentCompletionCommands(shell: CompletionShell): string[] {
  switch (shell) {
    case "bash":
      return [
        "mkdir -p ~/.local/share/pi-threads",
        "pi-threads completion script bash > ~/.local/share/pi-threads/completion.bash",
        "printf '\\nsource ~/.local/share/pi-threads/completion.bash\\n' >> ~/.bashrc",
      ];
    case "zsh":
      return [
        "mkdir -p ~/.local/share/pi-threads",
        "pi-threads completion script zsh > ~/.local/share/pi-threads/completion.zsh",
        "printf '\\nsource ~/.local/share/pi-threads/completion.zsh\\n' >> ~/.zshrc",
      ];
    case "fish":
      return [
        "mkdir -p ~/.config/fish/completions",
        "pi-threads completion script fish > ~/.config/fish/completions/pi-threads.fish",
      ];
  }
}

function completionScript(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return bashCompletionScript();
    case "zsh":
      return zshCompletionScript();
    case "fish":
      return fishCompletionScript();
  }
}

function bashCompletionScript(): string {
  return `_pi_threads_completion() {
  local cur
  local -a words
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  words=("\${COMP_WORDS[@]:1:COMP_CWORD-1}")
  mapfile -t COMPREPLY < <(pi-threads __complete -- "$cur" "\${words[@]}" 2>/dev/null)
}

complete -o bashdefault -o default -F _pi_threads_completion pi-threads
`;
}

function zshCompletionScript(): string {
  return `#compdef pi-threads

_pi_threads() {
  local current="\${words[CURRENT]}"
  local -a prior=()
  if (( CURRENT > 2 )); then
    prior=("\${words[2,$(( CURRENT - 1 ))]}")
  fi
  local -a names
  names=("\${(@f)$(pi-threads __complete -- "$current" "\${prior[@]}" 2>/dev/null)}")
  compadd -a names
}

compdef _pi_threads pi-threads
`;
}

function fishCompletionScript(): string {
  return `function __pi_threads_complete
  set -l current (commandline -ct)
  set -l words (commandline -opc)
  if test (count $words) -gt 0
    set -e words[1]
  end
  if test (count $words) -gt 0; and test "$words[-1]" = "$current"
    set -e words[-1]
  end
  pi-threads __complete -- "$current" $words 2>/dev/null
end

complete -c pi-threads -f -a '(__pi_threads_complete)'
`;
}
