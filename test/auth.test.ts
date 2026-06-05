import { describe, expect, it } from "vitest";
import { DaemonError } from "../src/errors.ts";
import {
  assertAuthConfiguredForBind,
  assertBearerToken,
  assertOriginAllowed,
} from "../src/security/auth.ts";
import { assertTlsAllowedForBind } from "../src/security/tls.ts";

describe("security helpers", () => {
  it("requires configured bearer tokens", () => {
    expect(() => assertBearerToken({ token: "secret" }, undefined)).toThrow(DaemonError);
    expect(() => assertBearerToken({ token: "secret" }, "Bearer wrong")).toThrow(DaemonError);
    expect(() => assertBearerToken({ token: "secret" }, "Bearer secret")).not.toThrow();
  });

  it("validates WebSocket origins", () => {
    expect(() => assertOriginAllowed(["https://example.test"], "https://other.test")).toThrow(
      DaemonError,
    );
    expect(() =>
      assertOriginAllowed(["https://example.test"], "https://example.test"),
    ).not.toThrow();
  });

  it("requires TLS on non-loopback binds", () => {
    expect(() => assertTlsAllowedForBind("0.0.0.0")).toThrow(DaemonError);
    expect(() => assertTlsAllowedForBind("127.0.0.1")).not.toThrow();
  });

  it("requires bearer auth on non-loopback binds", () => {
    expect(() => assertAuthConfiguredForBind("0.0.0.0", {})).toThrow(DaemonError);
    expect(() => assertAuthConfiguredForBind("0.0.0.0", { token: "secret" })).not.toThrow();
    expect(() => assertAuthConfiguredForBind("127.0.0.1", {})).not.toThrow();
  });
});
