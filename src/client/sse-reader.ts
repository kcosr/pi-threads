import { DaemonError } from "../errors.ts";
import { MAX_STREAM_BYTES } from "../protocol/stream.ts";

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/** HTTP chunks are not event boundaries; decode UTF-8 and SSE lines incrementally. */
export async function* readSse(input: AsyncIterable<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let event = "message";
  let id: string | undefined;
  let data: string[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      const raw = buffer.slice(0, index);
      const line = raw.replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      bytes += Buffer.byteLength(raw) + 1;
      if (bytes > MAX_STREAM_BYTES)
        throw new DaemonError("streamOverflow", "SSE frame exceeds its byte limit");
      if (!line) {
        if (data.length)
          yield { event, data: data.join("\n"), ...(id === undefined ? {} : { id }) };
        event = "message";
        id = undefined;
        data = [];
        bytes = 0;
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      if (field === "id" && !value.includes("\0")) id = value;
      if (field === "data") data.push(value);
    }
    if (bytes + Buffer.byteLength(buffer) > MAX_STREAM_BYTES)
      throw new DaemonError("streamOverflow", "SSE frame exceeds its byte limit");
  }
  decoder.decode(); // Reject truncated UTF-8. An unfinished SSE frame is never delivered.
}
