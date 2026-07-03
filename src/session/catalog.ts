import { existsSync, readFileSync, statSync, type Stats } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonError } from "../errors.ts";
import type { ThreadMessages, ThreadSummary } from "../protocol/types.ts";

export type SessionEntry = Record<string, unknown>;

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}

export interface FileBaseline {
  path: string;
  size: number;
  mtimeMs: number;
  lastEntryHash?: string;
}

export class PiSessionCatalog {
  private readonly byId = new Map<string, SessionInfo>();
  private readonly baselines = new Map<string, FileBaseline>();

  async list(cwd?: string): Promise<ThreadSummary[]> {
    const sessions = cwd ? await listSessionsForCwd(resolve(cwd)) : await listAllSessions();
    this.cache(sessions);
    return sessions.map((session) => this.toSummary(session));
  }

  async search(query: string, cwd?: string, limit?: number): Promise<ThreadSummary[]> {
    const lower = query.toLowerCase();
    const sessions = await this.list(cwd);
    const results = sessions.filter((session) =>
      [session.threadId, session.name, session.firstMessage, session.cwd]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(lower)),
    );
    return limit === undefined ? results : results.slice(0, limit);
  }

  async resolveThread(threadIdOrPath: string): Promise<SessionInfo> {
    if (existsSync(threadIdOrPath)) {
      const session = this.infoFromPath(resolve(threadIdOrPath));
      this.cache([session]);
      return session;
    }
    const cached = this.byId.get(threadIdOrPath);
    if (cached && existsSync(cached.path)) {
      return cached;
    }
    await this.list();
    const refreshed = this.byId.get(threadIdOrPath);
    if (!refreshed) {
      throw new DaemonError("notFound", "Thread not found", { threadId: threadIdOrPath });
    }
    return refreshed;
  }

  async read(threadIdOrPath: string): Promise<{ thread: ThreadSummary; entries: SessionEntry[] }> {
    const session = await this.resolveThread(threadIdOrPath);
    return {
      thread: this.toSummary(session),
      entries: readSessionEntries(session.path).filter(isNonHeaderEntry),
    };
  }

  async messages(
    threadIdOrPath: string,
    options?: { last?: number; role?: string },
  ): Promise<ThreadMessages> {
    const session = await this.resolveThread(threadIdOrPath);
    let messages: Array<Record<string, unknown>> = readSessionEntries(session.path)
      .filter((entry): entry is SessionEntry & { message: unknown } => entry.type === "message")
      .map((entry) => ({ entryId: entry.id, ...(entry.message as Record<string, unknown>) }));
    if (options?.role) {
      messages = messages.filter((message) => message.role === options.role);
    }
    if (options?.last !== undefined) {
      messages = messages.slice(-options.last);
    }
    return { threadId: session.id, messages };
  }

  recordBaseline(threadId: string, path: string): FileBaseline | undefined {
    const baseline = sampleBaseline(path);
    if (baseline) {
      this.baselines.set(threadId, baseline);
    }
    return baseline;
  }

  assertUnchanged(threadId: string): void {
    const baseline = this.baselines.get(threadId);
    if (!baseline) {
      return;
    }
    const current = sampleBaseline(baseline.path);
    if (!current) {
      throw new DaemonError("externalWriterDetected", "Session file disappeared", {
        threadId,
        path: baseline.path,
      });
    }
    if (
      current.size !== baseline.size ||
      current.mtimeMs !== baseline.mtimeMs ||
      current.lastEntryHash !== baseline.lastEntryHash
    ) {
      throw new DaemonError("externalWriterDetected", "Session changed outside daemon ownership", {
        threadId,
        path: baseline.path,
      });
    }
  }

  updateFromWorkerState(state: {
    sessionId?: string;
    sessionFile?: string;
    cwd?: string;
    sessionName?: string;
  }): void {
    if (!state.sessionId || !state.sessionFile) {
      return;
    }
    const session = existsSync(state.sessionFile)
      ? this.infoFromPath(state.sessionFile, state.cwd, state.sessionName)
      : ({
          path: state.sessionFile,
          id: state.sessionId,
          cwd: state.cwd ?? "",
          name: state.sessionName,
          created: new Date(),
          modified: new Date(),
          messageCount: 0,
          firstMessage: "",
          allMessagesText: "",
        } satisfies SessionInfo);
    this.cache([session]);
    if (existsSync(session.path)) {
      this.recordBaseline(session.id, session.path);
    }
  }

  private cache(sessions: SessionInfo[]): void {
    for (const session of sessions) {
      this.byId.set(session.id, session);
    }
  }

  private infoFromPath(path: string, cwdOverride?: string, nameOverride?: string): SessionInfo {
    const stat = statSync(path);
    const entries = readSessionEntries(path);
    const header = entries.find(isSessionHeader);
    const info = sessionInfoFromEntries(path, stat, entries);
    return {
      ...info,
      id: info.id || header?.id || path,
      cwd: cwdOverride ?? info.cwd,
      name: nameOverride ?? info.name,
    };
  }

  private toSummary(session: SessionInfo): ThreadSummary {
    return {
      threadId: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      parentSessionPath: session.parentSessionPath,
      created: session.created?.toISOString(),
      modified: session.modified?.toISOString(),
      messageCount: session.messageCount,
      firstMessage: session.firstMessage,
      status: "idle",
    };
  }
}

function sampleBaseline(path: string): FileBaseline | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const stat = statSync(path);
  const entries = readSessionEntries(path).filter(isNonHeaderEntry);
  const last = entries.at(-1);
  return {
    path,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    lastEntryHash: last ? `${last.id}:${last.type}:${last.timestamp}` : undefined,
  };
}

async function listSessionsForCwd(cwd: string): Promise<SessionInfo[]> {
  const customDir = configuredSessionDir();
  const shouldFilterCwd = Boolean(customDir);
  const sessions = (await listSessionsFromDir(customDir ?? defaultSessionDirForCwd(cwd))).filter(
    (session) => !shouldFilterCwd || sessionCwdMatches(session.cwd, cwd),
  );
  sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
  return sessions;
}

async function listAllSessions(): Promise<SessionInfo[]> {
  const customDir = configuredSessionDir();
  if (customDir) {
    const sessions = await listSessionsFromDir(customDir);
    sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
    return sessions;
  }
  const root = sessionsRoot();
  if (!existsSync(root)) {
    return [];
  }
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const sessionLists = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => listSessionsFromDir(join(root, entry.name))),
    );
    return sessionLists
      .flat()
      .sort((left, right) => right.modified.getTime() - left.modified.getTime());
  } catch {
    return [];
  }
}

async function listSessionsFromDir(dir: string): Promise<SessionInfo[]> {
  if (!existsSync(dir)) {
    return [];
  }
  try {
    const names = await readdir(dir);
    const sessions = names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => sessionInfoFromPath(join(dir, name)))
      .filter((info): info is SessionInfo => Boolean(info));
    return sessions;
  } catch {
    return [];
  }
}

function sessionInfoFromPath(path: string): SessionInfo | undefined {
  try {
    return sessionInfoFromEntries(path, statSync(path), readSessionEntries(path));
  } catch {
    return undefined;
  }
}

function sessionInfoFromEntries(
  path: string,
  stat: Stats,
  entries: SessionEntry[],
): SessionInfo {
  const header = entries.find(isSessionHeader);
  if (!header) {
    throw new Error(`Invalid Pi session file: ${path}`);
  }
  let messageCount = 0;
  let firstMessage = "";
  let name: string | undefined;
  const allMessages: string[] = [];

  for (const entry of entries) {
    if (entry.type === "session_info") {
      name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) {
      continue;
    }
    messageCount++;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = messageText(entry.message);
    if (!text) {
      continue;
    }
    allMessages.push(text);
    if (!firstMessage && role === "user") {
      firstMessage = text;
    }
  }

  return {
    path,
    id: header.id,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name,
    parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
    created: parseDate(header.timestamp, stat.birthtime),
    modified: sessionModifiedDate(entries, header, stat.mtime),
    messageCount,
    firstMessage: firstMessage || "(no messages)",
    allMessagesText: allMessages.join(" "),
  };
}

function readSessionEntries(path: string): SessionEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return isRecord(entry) ? [entry] : [];
      } catch {
        return [];
      }
    });
}

function isSessionHeader(entry: SessionEntry): entry is SessionEntry & { id: string } {
  return entry.type === "session" && typeof entry.id === "string";
}

function isNonHeaderEntry(entry: SessionEntry): boolean {
  return entry.type !== "session";
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function sessionModifiedDate(
  entries: SessionEntry[],
  header: SessionEntry,
  fallback: Date,
): Date {
  let lastActivityTime: number | undefined;
  for (const entry of entries) {
    if (entry.type !== "message" || !isRecord(entry.message)) {
      continue;
    }
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const messageTimestamp = entry.message.timestamp;
    if (typeof messageTimestamp === "number") {
      lastActivityTime = Math.max(lastActivityTime ?? 0, messageTimestamp);
      continue;
    }
    if (typeof entry.timestamp === "string") {
      const time = Date.parse(entry.timestamp);
      if (!Number.isNaN(time)) {
        lastActivityTime = Math.max(lastActivityTime ?? 0, time);
      }
    }
  }
  if (lastActivityTime) {
    return new Date(lastActivityTime);
  }
  return parseDate(header.timestamp, fallback);
}

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value !== "string") {
    return fallback;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? fallback : new Date(time);
}

function sessionsRoot(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "sessions");
}

function defaultSessionDirForCwd(cwd: string): string {
  const safePath = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(sessionsRoot(), safePath);
}

function configuredSessionDir(): string | undefined {
  return process.env.PI_CODING_AGENT_SESSION_DIR
    ? resolve(process.env.PI_CODING_AGENT_SESSION_DIR)
    : undefined;
}

function sessionCwdMatches(sessionCwd: string | undefined, cwd: string): boolean {
  return sessionCwd !== undefined && sessionCwd !== "" && resolve(sessionCwd) === resolve(cwd);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
