import crypto from "node:crypto";
import { DaemonError } from "../errors.ts";

export interface AuthConfig {
  token?: string;
  tokenEnv?: string;
  allowedOrigins?: string[];
}

export function resolveToken(config: AuthConfig): string | undefined {
  if (config.token) {
    return config.token;
  }
  if (config.tokenEnv) {
    return process.env[config.tokenEnv];
  }
  return undefined;
}

export function assertBearerToken(config: AuthConfig, authorizationHeader?: string): void {
  const expected = resolveToken(config);
  if (!expected) {
    return;
  }
  const actual = authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!actual) {
    throw new DaemonError("unauthorized", "Bearer token required");
  }
  if (!timingSafeEqualText(expected, actual)) {
    throw new DaemonError("forbidden", "Bearer token rejected");
  }
}

export function assertOriginAllowed(allowedOrigins: string[] | undefined, origin?: string): void {
  if (!allowedOrigins || allowedOrigins.length === 0 || !origin) {
    return;
  }
  if (!allowedOrigins.includes(origin)) {
    throw new DaemonError("forbidden", "WebSocket Origin rejected", { origin });
  }
}

function timingSafeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
