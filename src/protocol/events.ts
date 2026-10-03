export const DAEMON_EVENT_TYPES = [
  "turn.accepted",
  "turn.started",
  "run.step.started",
  "run.step.completed",
  "message.delta",
  "message.completed",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "retry.scheduled",
  "retry.completed",
  "queue.updated",
  "compaction.started",
  "compaction.completed",
  "extension_ui.requested",
  "extension_ui.completed",
  "extension.error",
  "turn.completed",
  "turn.aborted",
  "turn.failed",
  "worker.started",
  "worker.idle",
  "worker.crashed",
  "thread.updated",
] as const;

export type DaemonEventType = (typeof DAEMON_EVENT_TYPES)[number];

export interface DaemonEvent {
  eventId: string;
  type: DaemonEventType;
  timestamp: string;
  threadId?: string;
  turnId?: string;
  workerId?: string;
  payload: Record<string, unknown>;
}

export interface EventFilter {
  threadId?: string;
  turnId?: string;
  sinceEventId?: string;
  eventTypes?: DaemonEventType[];
}

export function isTerminalEventType(type: string): boolean {
  return type === "turn.completed" || type === "turn.failed" || type === "turn.aborted";
}
