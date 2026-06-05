#!/usr/bin/env bun
import { runCli } from "./cli/commands.ts";

runCli().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
