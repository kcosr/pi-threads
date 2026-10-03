import type { ServerResponse } from "node:http";
import { DaemonError } from "../errors.ts";
import { MAX_STREAM_BYTES } from "../protocol/stream.ts";

export const HEARTBEAT_MS = 15_000;
export const DRAIN_TIMEOUT_MS = 30_000;

export function encodeSse(event: string, data: unknown, id?: string): string {
  const frame = `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (Buffer.byteLength(frame) > MAX_STREAM_BYTES)
    throw new DaemonError("streamOverflow", "SSE frame exceeds its byte limit");
  return frame;
}

export function beginSse(response: ServerResponse): () => void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  const timer = setInterval(() => {
    if (!response.destroyed && !response.writableEnded && !response.writableNeedDrain)
      response.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);
  timer.unref();
  const stop = () => clearInterval(timer);
  response.once("close", stop);
  return () => {
    stop();
    response.off("close", stop);
  };
}

export async function writeSse(response: ServerResponse, frame: string): Promise<void> {
  if (response.destroyed || response.writableEnded)
    throw new DaemonError("streamInterrupted", "HTTP response closed");
  if (Buffer.byteLength(frame) > MAX_STREAM_BYTES)
    throw new DaemonError("streamOverflow", "SSE frame exceeds its byte limit");
  if (response.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      response.off("drain", drained);
      response.off("close", closed);
      response.off("error", failed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const failed = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const closed = () => failed(new DaemonError("streamInterrupted", "HTTP response closed"));
    const timer = setTimeout(() => {
      failed(new DaemonError("streamOverflow", "SSE reader did not drain in time"));
      response.destroy();
    }, DRAIN_TIMEOUT_MS);
    timer.unref();
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", failed);
  });
}
