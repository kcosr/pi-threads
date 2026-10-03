import { DaemonError } from "../errors.ts";
import type { PiRpcResponse } from "./pi-rpc-worker.ts";

export function promptDisposition(response: PiRpcResponse): "started" | "queued" | "handled" {
  const data = response.data;
  const disposition =
    data && typeof data === "object" && "disposition" in data ? data.disposition : undefined;
  if (disposition === "started" || disposition === "queued" || disposition === "handled") {
    return disposition;
  }
  throw new DaemonError("piRpcError", "Pi RPC response is missing a valid input disposition", {
    command: response.command,
  });
}

export function queueDisposition(response: PiRpcResponse): "queued" | "handled" {
  const disposition = promptDisposition(response);
  if (disposition === "started") {
    throw new DaemonError("piRpcError", "Pi RPC queue response has an invalid disposition", {
      command: response.command,
    });
  }
  return disposition;
}
