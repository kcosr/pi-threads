import { describe, expect, it } from "vitest";
import { isSupportedPiVersion, PI_COMPATIBILITY, usesAgentSettledEvent } from "../src/version.ts";

describe("Pi compatibility", () => {
  it("accepts the documented Pi range through 0.82.x", () => {
    expect(isSupportedPiVersion("0.75.0")).toBe(true);
    expect(isSupportedPiVersion("0.80.3")).toBe(true);
    expect(isSupportedPiVersion("0.82.1")).toBe(true);
    expect(isSupportedPiVersion("0.82.99-dev")).toBe(true);
    expect(isSupportedPiVersion("0.74.9")).toBe(false);
    expect(isSupportedPiVersion("0.83.0")).toBe(false);
    expect(isSupportedPiVersion("not-semver")).toBe(false);
    expect(PI_COMPATIBILITY.maximumExclusive).toBe("0.83.0");
  });

  it("uses agent_settled as the terminal event starting with Pi 0.81", () => {
    expect(usesAgentSettledEvent("0.80.3")).toBe(false);
    expect(usesAgentSettledEvent("0.81.0")).toBe(true);
    expect(usesAgentSettledEvent("0.82.1")).toBe(true);
    expect(usesAgentSettledEvent(undefined)).toBe(false);
  });
});
