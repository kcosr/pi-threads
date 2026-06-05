import type { DaemonEvent } from "../protocol/events.ts";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printNdjson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function renderHuman(value: unknown): void {
  if (Array.isArray(value)) {
    printRecords(value as Record<string, unknown>[]);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.threads)) {
      printThreads(record.threads as Record<string, unknown>[]);
      if (record.cursor) {
        printKeyValues([["cursor", record.cursor]]);
      }
      return;
    }
    if (Array.isArray(record.workers)) {
      printWorkers(record.workers as Record<string, unknown>[]);
      return;
    }
    if (Array.isArray(record.models)) {
      printModels(record.models as Record<string, unknown>[]);
      return;
    }
    if (Array.isArray(record.commands)) {
      printCommands(record.commands as Record<string, unknown>[]);
      return;
    }
    if (Array.isArray(record.messages)) {
      printMessages(record.messages as Record<string, unknown>[]);
      return;
    }
    if (isServerMap(record)) {
      printTable(
        ["SERVER", "ENDPOINT"],
        Object.entries(record).map(([name, server]) => [
          name,
          (server as Record<string, unknown>).endpoint,
        ]),
      );
      return;
    }
    if (record.thread && typeof record.thread === "object") {
      renderThreadRead(record);
      return;
    }
    if (record.worker && typeof record.worker === "object") {
      printWorkers([record.worker as Record<string, unknown>]);
      return;
    }
    printKeyValues(recordToKeyValues(record));
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

export function printTable(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): void {
  if (rows.length === 0) {
    process.stdout.write("No results\n");
    return;
  }
  const rendered = rows.map((row) => row.map((cell) => sanitizeCell(cell)));
  const widths = headers.map((header) => header.length);
  for (const row of rendered) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  printTableRow(headers, widths);
  for (const row of rendered) {
    printTableRow(row, widths);
  }
}

export function printKeyValues(rows: ReadonlyArray<readonly [string, unknown]>): void {
  const width = Math.max(0, ...rows.map(([key]) => key.length));
  for (const [key, value] of rows) {
    process.stdout.write(`${key.padEnd(width)}  ${sanitizeCell(formatValue(value))}\n`);
  }
}

export function renderThreadRead(value: Record<string, unknown>, itemView = "summary"): void {
  if (value.thread && typeof value.thread === "object") {
    printKeyValues(recordToKeyValues(value.thread as Record<string, unknown>));
  } else {
    printKeyValues(recordToKeyValues(value));
  }
  if (itemView === "none" || !Array.isArray(value.entries)) {
    return;
  }
  const messages = value.entries.flatMap((entry) => entryToMessage(entry, itemView === "full"));
  if (messages.length === 0) {
    return;
  }
  process.stdout.write("\n");
  printMessages(messages);
}

export function sanitizeCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function printThreads(rows: Record<string, unknown>[]): void {
  printTable(
    ["THREAD", "STATUS", "CWD", "NAME", "MESSAGES", "MODIFIED"],
    rows.map((row) => [
      row.threadId,
      row.status,
      row.cwd,
      row.name,
      row.messageCount,
      row.modified,
    ]),
  );
}

function printWorkers(rows: Record<string, unknown>[]): void {
  printTable(
    ["WORKER", "STATE", "THREAD", "CWD", "PID", "VERSION", "LAST USED"],
    rows.map((row) => [
      row.workerId,
      row.state,
      row.threadId,
      row.cwd,
      row.pid,
      row.version,
      row.lastUsedAt,
    ]),
  );
}

function printModels(rows: Record<string, unknown>[]): void {
  printTable(
    ["MODEL", "PROVIDER", "NAME", "CONTEXT", "INPUT"],
    rows.map((row) => [
      row.id,
      row.provider,
      row.name,
      row.contextWindow,
      Array.isArray(row.input) ? row.input.join(",") : row.input,
    ]),
  );
}

function printCommands(rows: Record<string, unknown>[]): void {
  printTable(
    ["COMMAND", "SOURCE", "DESCRIPTION"],
    rows.map((row) => [row.name, row.source, row.description]),
  );
}

export function printMessages(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    process.stdout.write("No results\n");
    return;
  }
  rows.forEach((message, index) => {
    if (index > 0) {
      process.stdout.write("\n");
    }
    const role = sanitizeCell(message.role ?? "message");
    const stamp = message.createdAt ?? message.timestamp;
    process.stdout.write(`[${role}${stamp ? ` ${sanitizeCell(stamp)}` : ""}]\n`);
    process.stdout.write(`${messageText(message)}\n`);
  });
}

function printRecords(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    process.stdout.write("No results\n");
    return;
  }
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  printTable(
    columns.map((column) => column.toUpperCase()),
    rows.map((row) => columns.map((column) => row[column])),
  );
}

function printTableRow(row: ReadonlyArray<string>, widths: ReadonlyArray<number>): void {
  const columns = widths.map((width, index) => {
    const value = row[index] ?? "";
    return index + 1 === widths.length ? value : value.padEnd(width);
  });
  process.stdout.write(`${columns.join("  ")}\n`);
}

function recordToKeyValues(record: Record<string, unknown>): Array<readonly [string, unknown]> {
  return Object.entries(record).map(([key, value]) => [key, value] as const);
}

function formatValue(value: unknown): unknown {
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  return value;
}

function isServerMap(record: Record<string, unknown>): boolean {
  const values = Object.values(record);
  return (
    values.length > 0 &&
    values.every((value) => value && typeof value === "object" && "endpoint" in value)
  );
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content ?? message.text ?? message.message;
  if (Array.isArray(content)) {
    return content
      .map((part) => messagePartText(part))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "string") {
    return content.trim();
  }
  if (content !== undefined) {
    return sanitizeCell(JSON.stringify(content));
  }
  return sanitizeCell(JSON.stringify(message));
}

function messagePartText(part: unknown): string {
  if (!part || typeof part !== "object") {
    return sanitizeCell(part);
  }
  const record = part as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text.trim();
  }
  if (typeof record.thinking === "string") {
    return record.thinking.trim();
  }
  return sanitizeCell(JSON.stringify(record));
}

function entryToMessage(entry: unknown, full: boolean): Record<string, unknown>[] {
  if (!entry || typeof entry !== "object") {
    return [];
  }
  const record = entry as Record<string, unknown>;
  if (record.type !== "message" || !record.message || typeof record.message !== "object") {
    return [];
  }
  const message = record.message as Record<string, unknown>;
  return [
    {
      role: message.role ?? "message",
      createdAt: message.createdAt ?? message.timestamp ?? record.timestamp,
      text: full ? JSON.stringify(record, null, 2) : messageText(message),
    },
  ];
}
