import { readFileSync } from "node:fs";
import { DaemonError } from "../errors.ts";

export interface TlsConfig {
  ca?: string;
  cert?: string;
  key?: string;
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function assertTlsAllowedForBind(host: string, tls?: TlsConfig): void {
  if (isLoopbackHost(host)) {
    return;
  }
  if (!tls?.cert || !tls.key) {
    throw new DaemonError("forbidden", "Non-loopback TCP requires TLS certificate and key", {
      bind: host,
    });
  }
}

export function loadTlsOptions(
  tls?: TlsConfig,
): undefined | { ca?: Buffer; cert: Buffer; key: Buffer } {
  if (!tls?.cert || !tls.key) {
    return undefined;
  }
  return {
    ...(tls.ca ? { ca: readFileSync(tls.ca) } : {}),
    cert: readFileSync(tls.cert),
    key: readFileSync(tls.key),
  };
}
