export type DaemonEventType =
  | "turn.accepted"
  | "turn.started"
  | "run.step.started"
  | "run.step.completed"
  | "message.delta"
  | "message.completed"
  | "tool.started"
  | "tool.completed"
  | "retry.scheduled"
  | "retry.completed"
  | "queue.updated"
  | "compaction.started"
  | "compaction.completed"
  | "extension_ui.requested"
  | "extension_ui.completed"
  | "extension.error"
  | "turn.completed"
  | "turn.aborted"
  | "turn.failed"
  | "worker.started"
  | "worker.idle"
  | "worker.crashed"
  | "thread.updated";

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
