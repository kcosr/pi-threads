import type { DaemonEventType } from "./events.ts";

export type ThreadStatusValue = "idle" | "running" | "error" | "unknown" | "unknown-external";
export type TurnStatusValue =
  | "accepted"
  | "running"
  | "completed"
  | "aborted"
  | "failed"
  | "unknown";
export type QueueMode = "all" | "one-at-a-time";

export interface ThreadSummary {
  threadId: string;
  path?: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created?: string;
  modified?: string;
  messageCount: number;
  firstMessage?: string;
  status: ThreadStatusValue;
}

export interface ThreadMessages {
  threadId: string;
  messages: unknown[];
}

export interface ThreadReadResult {
  thread: ThreadSummary;
  entries?: unknown[];
}

export interface AcceptedTurn {
  threadId: string;
  turnId: string;
  workerId: string;
  status: TurnStatusValue;
}

export interface QueuedFollowUp {
  threadId: string;
  queuedForTurnId?: string;
  status: "queued";
}

export interface WorkerStatus {
  workerId: string;
  pid?: number;
  cwd: string;
  state: "starting" | "idle" | "assigned" | "running" | "crashed" | "stopped";
  threadId?: string;
  version?: string;
  startedAt: string;
  lastUsedAt: string;
}

export interface ServerStatus {
  version: string;
  piCompatibility: {
    testedRange: string;
    minimum: string;
    maximumExclusive: string;
    tested: readonly string[];
  };
  uptimeMs: number;
  workers: WorkerStatus[];
  transports: string[];
}

export interface SubscriptionRequest {
  threadId?: string;
  turnId?: string;
  sinceEventId?: string;
  eventTypes?: DaemonEventType[];
}
