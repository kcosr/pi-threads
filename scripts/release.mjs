#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "kcosr/pi-threads";
const RELEASE_BRANCH = "main";
const PLATFORMS = ["linux-x86_64", "linux-arm64", "macos-x86_64", "macos-arm64"];
const releaseArg = process.argv[2];

if (
  !releaseArg ||
  (!new Set(["current", "patch", "minor", "major"]).has(releaseArg) &&
    !/^\d+\.\d+\.\d+$/.test(releaseArg))
) {
  throw new Error("Usage: node scripts/release.mjs <current|patch|minor|major|X.Y.Z>");
}

ensureCleanMain();
ensureTools();
ensureSyncedMain();
const currentVersion = readPackageVersion();
const version = releaseArg === "current" ? currentVersion : bumpVersion(currentVersion, releaseArg);
ensureTagAvailable(version);
validateUnreleasedNotes();
if (version !== currentVersion) updateVersion(version);
run("bun", ["install", "--frozen-lockfile"]);
run("bun", ["run", "verify"]);
run("git", ["diff", "--check"]);

stampChangelog(version);
run("git", ["add", "package.json", "src/version.ts", "CHANGELOG.md", "bun.lock"]);
run("git", ["commit", "-m", `Release v${version}`]);
run("git", ["tag", `v${version}`]);
run("git", ["push", "--atomic", "origin", RELEASE_BRANCH, `v${version}`]);

const releaseDir = path.join(ROOT, "dist-release", `v${version}`);
const archives = PLATFORMS.map((platform) => {
  run("node", ["scripts/package-release.mjs", "--platform", platform, "--out-dir", releaseDir]);
  return path.join(releaseDir, `pi-threads-${version}-${platform}.tar.gz`);
});
for (const archive of archives) {
  if (!existsSync(archive)) throw new Error(`expected release archive was not created: ${archive}`);
}
smokeTestNativeArchive(archives[0]);
const checksums = path.join(releaseDir, "SHA256SUMS");
writeFileSync(
  checksums,
  `${archives.map((archive) => `${sha256(archive)}  ${path.basename(archive)}`).join("\n")}\n`,
);
verifyChecksums(checksums, archives);

const notesDir = mkdtempSync(path.join(tmpdir(), "pi-threads-release-notes-"));
const notesFile = path.join(notesDir, "notes.md");
try {
  writeFileSync(notesFile, releaseNotes(version));
  run("gh", [
    "release",
    "create",
    `v${version}`,
    "--repo",
    REPO,
    "--title",
    `v${version}`,
    "--notes-file",
    notesFile,
    ...archives,
    checksums,
  ]);
} finally {
  rmSync(notesDir, { recursive: true, force: true });
}

addUnreleasedSection();
run("git", ["add", "CHANGELOG.md"]);
run("git", ["commit", "-m", "Prepare for next release"]);
run("git", ["push", "origin", RELEASE_BRANCH]);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.silent ? "pipe" : "inherit",
  });
}

function ensureCleanMain() {
  if (run("git", ["branch", "--show-current"], { silent: true }).trim() !== RELEASE_BRANCH)
    throw new Error(`releases must run from ${RELEASE_BRANCH}`);
  const status = run("git", ["status", "--porcelain"], { silent: true }).trim();
  if (status) throw new Error(`uncommitted changes detected:\n${status}`);
}

function ensureTools() {
  for (const [command, args] of [
    ["bun", ["--version"]],
    ["gh", ["auth", "status", "--hostname", "github.com"]],
  ]) {
    run(command, args, { silent: true });
  }
}

function ensureSyncedMain() {
  run(
    "git",
    ["fetch", "origin", `refs/heads/${RELEASE_BRANCH}:refs/remotes/origin/${RELEASE_BRANCH}`],
    { silent: true },
  );
  const local = run("git", ["rev-parse", RELEASE_BRANCH], { silent: true }).trim();
  const remote = run("git", ["rev-parse", `origin/${RELEASE_BRANCH}`], { silent: true }).trim();
  if (local !== remote) throw new Error(`${RELEASE_BRANCH} must match origin/${RELEASE_BRANCH}`);
}

function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version))
    throw new Error("package.json version must be stable semver");
  return pkg.version;
}

function bumpVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [major, minor, patch] = current.split(".").map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function ensureTagAvailable(version) {
  const tag = `v${version}`;
  if (run("git", ["tag", "--list", tag], { silent: true }).trim())
    throw new Error(`tag ${tag} already exists locally`);
  if (run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { silent: true }).trim())
    throw new Error(`tag ${tag} already exists on origin`);
}

function updateVersion(version) {
  const packagePath = path.join(ROOT, "package.json");
  const versionPath = path.join(ROOT, "src", "version.ts");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  pkg.version = version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const source = readFileSync(versionPath, "utf8");
  const updated = source.replace(/(export const PACKAGE_VERSION = ")[^"]+(";)/, `$1${version}$2`);
  if (updated === source) throw new Error("could not update src/version.ts");
  writeFileSync(versionPath, updated);
}

function changelog() {
  return readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
}

function sectionNotes(name) {
  const content = changelog();
  const heading = new RegExp(`^## \\[${escapeRegExp(name)}\\][^\\n]*\\n`, "m");
  const match = heading.exec(content);
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  const end = content.indexOf("\n## [", start);
  return content.slice(start, end === -1 ? content.length : end).trim();
}

function validateUnreleasedNotes() {
  const notes = sectionNotes("Unreleased");
  if (!notes || notes === "_No unreleased changes._")
    throw new Error("CHANGELOG.md needs release notes under [Unreleased]");
}

function stampChangelog(version) {
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(
    path.join(ROOT, "CHANGELOG.md"),
    changelog().replace(/^## \[Unreleased\]/m, `## [${version}] - ${date}`),
  );
}

function releaseNotes(version) {
  const notes = sectionNotes(version);
  if (!notes) throw new Error(`could not extract notes for v${version}`);
  return notes;
}

function addUnreleasedSection() {
  const content = changelog();
  const next = content.replace(
    "# Changelog\n\n",
    "# Changelog\n\n## [Unreleased]\n\n_No unreleased changes._\n\n",
  );
  if (next === content) throw new Error("could not create the next [Unreleased] section");
  writeFileSync(path.join(ROOT, "CHANGELOG.md"), next);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function verifyChecksums(checksumPath, archives) {
  const expected = new Map(
    readFileSync(checksumPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(/\s{2,}/u))
      .map(([hash, name]) => [name, hash]),
  );
  for (const archive of archives) {
    if (expected.get(path.basename(archive)) !== sha256(archive))
      throw new Error(`checksum verification failed for ${path.basename(archive)}`);
  }
}

function smokeTestNativeArchive(archivePath) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-threads-release-smoke-"));
  try {
    run("tar", ["-C", root, "-xzf", archivePath]);
    const binary = path.join(root, path.basename(archivePath, ".tar.gz"), "pi-threads");
    const output = run(binary, ["--version"], { silent: true });
    if (!/^\d+\.\d+\.\d+\n$/u.test(output))
      throw new Error("native release binary did not print its version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
