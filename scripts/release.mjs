#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const arg = process.argv[2] ?? "current";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const status = execSync("git status --short", { encoding: "utf8" }).trim();
if (status) {
  throw new Error("release requires a clean worktree");
}
const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
if (branch !== "main") {
  throw new Error("release must run on main");
}
execSync("git fetch --tags", { stdio: "inherit" });
execSync("git diff --quiet @{u} HEAD", { stdio: "inherit" });

const version = nextVersion(pkg.version, arg);
if (execSync(`git tag --list v${version}`, { encoding: "utf8" }).trim()) {
  throw new Error(`tag v${version} already exists`);
}

pkg.version = version;
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
execSync("bun install", { stdio: "inherit" });
execSync("bun run verify", { stdio: "inherit" });
execSync("git add package.json bun.lock CHANGELOG.md", { stdio: "inherit" });
execSync(`git commit -m "Release v${version}"`, { stdio: "inherit" });
execSync(`git tag v${version}`, { stdio: "inherit" });
execSync("git push --follow-tags", { stdio: "inherit" });

function nextVersion(current, mode) {
  if (/^\d+\.\d+\.\d+$/.test(mode)) {
    return mode;
  }
  if (mode === "current") {
    return current;
  }
  const parts = current.split(".").map(Number);
  if (mode === "patch") parts[2] += 1;
  else if (mode === "minor") {
    parts[1] += 1;
    parts[2] = 0;
  } else if (mode === "major") {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else {
    throw new Error(`unknown release mode: ${mode}`);
  }
  return parts.join(".");
}
