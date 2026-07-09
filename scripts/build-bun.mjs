#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { bundle, outfile, target } = parseArgs(process.argv.slice(2));
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const bunExecutable = process.env.BUN_EXECUTABLE?.trim() || "bun";

if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  throw new Error("package.json version must be stable semver");
}

try {
  execFileSync(bunExecutable, ["--version"], { stdio: "ignore" });
} catch {
  throw new Error(
    "Bun is required to build pi-threads; set BUN_EXECUTABLE or install Bun and retry.",
  );
}

const absoluteOutfile = path.resolve(ROOT, outfile);
mkdirSync(path.dirname(absoluteOutfile), { recursive: true });

const buildArgs = bundle
  ? [
      "build",
      "src/index.ts",
      "--target=bun",
      "--define",
      `__PI_THREADS_VERSION__=${JSON.stringify(pkg.version)}`,
      "--outfile",
      absoluteOutfile,
    ]
  : [
      "build",
      "src/index.ts",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      ...(target ? [`--target=${target}`] : []),
      "--define",
      `__PI_THREADS_VERSION__=${JSON.stringify(pkg.version)}`,
      "--outfile",
      absoluteOutfile,
    ];

execFileSync(bunExecutable, buildArgs, { cwd: ROOT, stdio: "inherit" });

function parseArgs(args) {
  let bundle = false;
  let outfile;
  let target;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--bundle") {
      bundle = true;
      continue;
    }
    if (arg === "--outfile") {
      const value = args[++index];
      if (!value) throw new Error("--outfile requires a path");
      outfile = value;
      continue;
    }
    if (arg === "--target") {
      const value = args[++index];
      if (!value) throw new Error("--target requires a Bun compile target");
      target = value;
      continue;
    }
    throw new Error(`unsupported argument: ${arg}`);
  }
  if (!outfile) {
    throw new Error(
      "Usage: node scripts/build-bun.mjs [--bundle] --outfile <path> [--target <bun-target>]",
    );
  }
  if (bundle && target) throw new Error("--target is only valid for standalone executable builds");
  return { bundle, outfile, target };
}
