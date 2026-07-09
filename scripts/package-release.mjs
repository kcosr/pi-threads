#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "pi-threads";
const PLATFORMS = {
  "linux-x86_64": { bunTarget: "bun-linux-x64", format: "elf", machine: 0x3e },
  "linux-arm64": { bunTarget: "bun-linux-arm64", format: "elf", machine: 0xb7 },
  "macos-x86_64": { bunTarget: "bun-darwin-x64", format: "macho", cpuType: 0x01000007 },
  "macos-arm64": { bunTarget: "bun-darwin-arm64", format: "macho", cpuType: 0x0100000c },
};

const { platform, outDir } = parseArgs(process.argv.slice(2));
const target = PLATFORMS[platform];
if (!target)
  throw new Error(
    `unsupported --platform ${platform}; expected one of ${Object.keys(PLATFORMS).join(", ")}`,
  );

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  throw new Error("package.json version must be stable semver");
}

const releaseName = `${PACKAGE_NAME}-${pkg.version}-${platform}`;
const outputDir = path.resolve(ROOT, outDir);
const archivePath = path.join(outputDir, `${releaseName}.tar.gz`);
const stagingRoot = mkdtempSync(path.join(tmpdir(), `${PACKAGE_NAME}-release-`));
const releaseRoot = path.join(stagingRoot, releaseName);

try {
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(releaseRoot, { recursive: true });
  run("node", [
    "scripts/build-bun.mjs",
    "--target",
    target.bunTarget,
    "--outfile",
    path.join(releaseRoot, PACKAGE_NAME),
  ]);
  const binary = path.join(releaseRoot, PACKAGE_NAME);
  chmodSync(binary, 0o755);
  validateBinary(binary, target);
  for (const name of ["README.md", "LICENSE", "CHANGELOG.md", "config.example.json"]) {
    cpSync(path.join(ROOT, name), path.join(releaseRoot, name));
  }
  mkdirSync(path.join(releaseRoot, "smoke"), { recursive: true });
  cpSync(path.join(ROOT, "smoke", "README.md"), path.join(releaseRoot, "smoke", "README.md"), {
    recursive: true,
  });
  cpSync(path.join(ROOT, "docs"), path.join(releaseRoot, "docs"), { recursive: true });

  rmSync(archivePath, { force: true });
  run("tar", ["-C", stagingRoot, "-czf", archivePath, releaseName]);
  validateArchive(archivePath, releaseName);
  process.stdout.write(`${archivePath}\n`);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}

function parseArgs(args) {
  let platform;
  let outDir = "dist-release";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--platform") platform = args[++index];
    else if (arg === "--out-dir") outDir = args[++index];
    else throw new Error(`unsupported argument: ${arg}`);
  }
  if (!platform || !outDir)
    throw new Error(
      "Usage: node scripts/package-release.mjs --platform <platform> [--out-dir <directory>]",
    );
  return { platform, outDir };
}

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
}

function validateBinary(binaryPath, target) {
  const data = readFileSync(binaryPath);
  if (data.length < 32) throw new Error(`compiled binary is unexpectedly small: ${binaryPath}`);
  if (target.format === "elf") {
    if (
      data[0] !== 0x7f ||
      data.subarray(1, 4).toString("ascii") !== "ELF" ||
      data.readUInt16LE(18) !== target.machine
    ) {
      throw new Error(`compiled ELF has the wrong platform for ${target.bunTarget}`);
    }
  } else if (data.readUInt32LE(0) !== 0xfeedfacf || data.readUInt32LE(4) !== target.cpuType) {
    throw new Error(`compiled Mach-O has the wrong platform for ${target.bunTarget}`);
  }
  if ((statSync(binaryPath).mode & 0o111) === 0)
    throw new Error(`compiled binary is not executable: ${binaryPath}`);
}

function validateArchive(archivePath, releaseName) {
  const entries = execFileSync("tar", ["-tzf", archivePath], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const required = [
    `${releaseName}/pi-threads`,
    `${releaseName}/README.md`,
    `${releaseName}/LICENSE`,
    `${releaseName}/CHANGELOG.md`,
    `${releaseName}/config.example.json`,
    `${releaseName}/smoke/README.md`,
    `${releaseName}/docs/cli-parity-audit.md`,
    `${releaseName}/docs/config-option-implementation-audit.md`,
  ];
  if (entries.some((entry) => entry !== releaseName && !entry.startsWith(`${releaseName}/`))) {
    throw new Error(`archive contains an entry outside ${releaseName}/`);
  }
  for (const expected of required) {
    if (!entries.includes(expected)) throw new Error(`archive is missing ${expected}`);
  }
  if (entries.length !== new Set(entries).size)
    throw new Error("archive contains duplicate entries");
  if (!statSync(archivePath).isFile()) throw new Error(`archive was not created: ${archivePath}`);
}
