import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(tmpdir(), `pi-threads-mock-${Date.now()}`);
const bin = join(root, "pi");
const socket = join(root, "daemon.sock");
const configPath = join(root, "config.json");
const workdir = join(root, "work");
mkdirSync(workdir, { recursive: true });
writeFileSync(
  bin,
  `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
if (process.argv.includes("--version")) { console.log("0.75.5"); process.exit(0); }
if (!process.argv.includes("--mode") || !process.argv.includes("rpc")) process.exit(2);
let id = "mock-" + Math.random().toString(16).slice(2);
let file = path.join(process.cwd(), ".fake-pi", id + ".jsonl");
let name;
function ensureSession() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({type:"session",version:3,id,timestamp:new Date().toISOString(),cwd:process.cwd()}) + "\\n");
}
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const i = buffer.indexOf("\\n");
    if (i < 0) break;
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === "new_session") { id = "mock-" + Math.random().toString(16).slice(2); file = path.join(process.cwd(), ".fake-pi", id + ".jsonl"); ensureSession(); send({id:cmd.id,type:"response",command:"new_session",success:true,data:{cancelled:false}}); }
    else if (cmd.type === "switch_session") { file = cmd.sessionPath; const header = JSON.parse(fs.readFileSync(file, "utf8").split("\\n")[0]); id = header.id; send({id:cmd.id,type:"response",command:"switch_session",success:true,data:{cancelled:false}}); }
    else if (cmd.type === "get_state") { ensureSession(); send({id:cmd.id,type:"response",command:"get_state",success:true,data:{sessionId:id,sessionFile:file,sessionName:name,thinkingLevel:"medium",isStreaming:false,isCompacting:false,steeringMode:"all",followUpMode:"one-at-a-time",autoCompactionEnabled:true,messageCount:0,pendingMessageCount:0}}); }
    else if (cmd.type === "prompt") { ensureSession(); send({id:cmd.id,type:"response",command:"prompt",success:true}); send({type:"agent_start",id:"run"}); setTimeout(() => { fs.appendFileSync(file, JSON.stringify({type:"message",id:"m1",parentId:null,timestamp:new Date().toISOString(),message:{role:"user",content:cmd.message}})+"\\n"); send({type:"message_complete",role:"assistant",content:"ok"}); send({type:"agent_end",status:"completed"}); }, 20); }
    else if (cmd.type === "set_session_name") { ensureSession(); name = cmd.name; fs.appendFileSync(file, JSON.stringify({type:"session_info",id:"n1",parentId:null,timestamp:new Date().toISOString(),name})+"\\n"); send({id:cmd.id,type:"response",command:"set_session_name",success:true}); }
    else if (cmd.type === "get_messages") { send({id:cmd.id,type:"response",command:"get_messages",success:true,data:{messages:[{role:"user",content:"mock"}]}}); }
    else if (cmd.type === "get_available_models") { send({id:cmd.id,type:"response",command:"get_available_models",success:true,data:{models:[{provider:"mock",id:"mock-model"}]}}); }
    else if (cmd.type === "get_session_stats") { send({id:cmd.id,type:"response",command:"get_session_stats",success:true,data:{bestEffort:true}}); }
    else if (cmd.type === "get_commands") { send({id:cmd.id,type:"response",command:"get_commands",success:true,data:{commands:[]}}); }
    else if (cmd.type === "export_html") { fs.writeFileSync(cmd.outputPath, "<html>mock</html>"); send({id:cmd.id,type:"response",command:"export_html",success:true,data:{path:cmd.outputPath}}); }
    else { send({id:cmd.id,type:"response",command:cmd.type,success:true,data:{}}); }
  }
});
`,
);
chmodSync(bin, 0o755);
writeFileSync(
  configPath,
  JSON.stringify({
    daemon: { unixSocket: socket, worker: { minWorkers: 0, maxWorkers: 3, idleTtlMs: 1000 } },
    servers: { local: { endpoint: `unix://${socket}` } },
  }),
);

const daemon = spawn("bun", ["run", "src/index.ts", "--config", configPath, "daemon", "start"], {
  env: { ...process.env, PI_THREADS_PI_BIN: bin },
  stdio: ["ignore", "pipe", "pipe"],
});
let daemonStdout = "";
let daemonStderr = "";
daemon.stdout.setEncoding("utf8");
daemon.stderr.setEncoding("utf8");
daemon.stdout.on("data", (chunk) => {
  daemonStdout += chunk;
});
daemon.stderr.on("data", (chunk) => {
  daemonStderr += chunk;
});

try {
  await waitFor(
    () => existsSync(socket),
    5_000,
    () => `daemon stdout:\n${daemonStdout}\ndaemon stderr:\n${daemonStderr}`,
  );
  const base = ["run", "src/index.ts", "--config", configPath, "--connect", `unix://${socket}`];
  await cli([...base, "servers", "ping"]);
  const started = await cli([
    ...base,
    "--json",
    "--no-wait",
    "new",
    "--cwd",
    workdir,
    "--name",
    "mock",
  ]);
  const parsed = JSON.parse(started);
  await cli([...base, "list", "--cwd", workdir]);
  await cli([...base, "status", parsed.threadId]);
  await cli([...base, "messages", parsed.threadId]);
  await cli([...base, "name", parsed.threadId, "renamed"]);
  await cli([...base, "models"]);
  const prompted = await cli([...base, "new", "--cwd", workdir, "hi"]);
  if (/worker\.started|message\.delta|turn\.started/.test(prompted)) {
    throw new Error(`default streaming leaked raw daemon events:\n${prompted}`);
  }
  await cli([...base, "daemon", "stop"]);
  console.log("mock smoke passed");
} finally {
  daemon.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
}

async function cli(args: string[]): Promise<string> {
  const child = spawn("bun", args, { env: { ...process.env, PI_THREADS_PI_BIN: bin } });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  if (code !== 0) {
    throw new Error(`command failed: bun ${args.join(" ")}\\n${stderr}`);
  }
  return stdout;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  diagnostics?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for daemon socket\n${diagnostics?.() ?? ""}`);
}
