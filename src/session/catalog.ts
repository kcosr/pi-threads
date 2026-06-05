import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  SessionManager,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { DaemonError } from "../errors.ts";
import type { ThreadMessages, ThreadSummary } from "../protocol/types.ts";

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
    const sessions = cwd ? await SessionManager.list(resolve(cwd)) : await SessionManager.listAll();
    this.cache(sessions);
    return sessions.map((session) => this.toSummary(session));
  }

  async search(query: string, cwd?: string, limit = 25): Promise<ThreadSummary[]> {
    const lower = query.toLowerCase();
    const sessions = await this.list(cwd);
    return sessions
      .filter((session) =>
        [session.threadId, session.name, session.firstMessage, session.cwd]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(lower)),
      )
      .slice(0, limit);
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
    const manager = SessionManager.open(session.path);
    return {
      thread: this.toSummary(session),
      entries: manager.getEntries(),
    };
  }

  async messages(
    threadIdOrPath: string,
    options?: { last?: number; role?: string },
  ): Promise<ThreadMessages> {
    const session = await this.resolveThread(threadIdOrPath);
    const manager = SessionManager.open(session.path);
    let messages: Array<Record<string, unknown>> = manager
      .getEntries()
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
    const manager = SessionManager.open(path);
    const header = manager.getHeader();
    const stat = statSync(path);
    const entries = manager.getEntries();
    const firstMessage = entries.find((entry) => entry.type === "message") as
      | (SessionEntry & { message?: { content?: unknown } })
      | undefined;
    const allMessagesText = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    return {
      path,
      id: manager.getSessionId() || header?.id || path,
      cwd: cwdOverride ?? header?.cwd ?? "",
      name: nameOverride ?? manager.getSessionName(),
      parentSessionPath: header?.parentSession,
      created: new Date(header?.timestamp ?? stat.birthtime),
      modified: stat.mtime,
      messageCount: entries.filter((entry) => entry.type === "message").length,
      firstMessage:
        typeof firstMessage?.message?.content === "string" ? firstMessage.message.content : "",
      allMessagesText,
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
  const manager = SessionManager.open(path);
  const entries = manager.getEntries();
  const last = entries.at(-1);
  return {
    path,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    lastEntryHash: last ? `${last.id}:${last.type}:${last.timestamp}` : undefined,
  };
}
