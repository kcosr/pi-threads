import { DaemonError, toDaemonError } from "../errors.ts";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: string;
    message: string;
    data?: Record<string, unknown>;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === "2.0" && typeof candidate.method === "string";
}

export function success(id: JsonRpcRequest["id"], result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function failure(id: JsonRpcRequest["id"], error: unknown): JsonRpcFailure {
  const daemonError = toDaemonError(error);
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: daemonError.code,
      message: daemonError.message,
      ...(daemonError.data ? { data: daemonError.data } : {}),
    },
  };
}

export function parseJsonRpcLine(line: string): JsonRpcRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new DaemonError("invalidParams", "Invalid JSON-RPC JSON", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isJsonRpcRequest(parsed)) {
    throw new DaemonError("invalidParams", "Expected JSON-RPC 2.0 request");
  }
  return parsed;
}

export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
