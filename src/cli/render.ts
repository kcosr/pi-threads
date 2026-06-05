import type { DaemonEvent } from "../protocol/events.ts";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printNdjson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function renderHuman(value: unknown): void {
  if (Array.isArray(value)) {
    renderTable(value as Record<string, unknown>[]);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.threads)) {
      renderTable(record.threads as Record<string, unknown>[]);
      if (record.cursor) {
        process.stdout.write(`cursor\t${record.cursor}\n`);
      }
      return;
    }
    if (Array.isArray(record.workers)) {
      renderTable(record.workers as Record<string, unknown>[]);
      return;
    }
    for (const [key, item] of Object.entries(record)) {
      if (typeof item === "object") {
        process.stdout.write(`${key}\t${JSON.stringify(item)}\n`);
      } else {
        process.stdout.write(`${key}\t${String(item)}\n`);
      }
    }
    return;
  }
  process.stdout.write(`${String(value)}\n`);
}

export function renderEvent(event: DaemonEvent, json: boolean): void {
  if (json) {
    printNdjson(event);
    return;
  }
  const scope = [event.threadId, event.turnId, event.workerId].filter(Boolean).join(" ");
  process.stdout.write(`${event.type}${scope ? ` ${scope}` : ""}\n`);
}

function renderTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    process.stdout.write("No results\n");
    return;
  }
  const preferred = [
    "threadId",
    "workerId",
    "status",
    "state",
    "cwd",
    "name",
    "messageCount",
    "modified",
  ];
  const columns = preferred.filter((column) => rows.some((row) => row[column] !== undefined));
  for (const row of rows) {
    process.stdout.write(columns.map((column) => String(row[column] ?? "")).join("\t"));
    process.stdout.write("\n");
  }
}
