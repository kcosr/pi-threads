export type ErrorCode =
  | "invalidParams"
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "busy"
  | "capacity"
  | "externalWriterDetected"
  | "workerCrashed"
  | "piRpcError"
  | "timeout"
  | "internal";

export class DaemonError extends Error {
  readonly code: ErrorCode;
  readonly data: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "DaemonError";
    this.code = code;
    this.data = data;
  }
}

export function toDaemonError(error: unknown): DaemonError {
  if (error instanceof DaemonError) {
    return error;
  }
  if (error instanceof Error) {
    return new DaemonError("internal", error.message);
  }
  return new DaemonError("internal", String(error));
}
