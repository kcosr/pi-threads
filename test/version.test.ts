import { describe, expect, it } from "vitest";
import { isSupportedPiVersion, PI_COMPATIBILITY } from "../src/version.ts";

describe("Pi compatibility", () => {
  it.each(["1.0.0", "1.0.1", "1.0.99", "1.0.0+build.1", "1.0.0\n"])("accepts Pi %s", (version) => {
    expect(isSupportedPiVersion(version)).toBe(true);
  });

  it.each([
    "0.75.5",
    "0.82.1",
    "0.99.2",
    "1.1.0",
    "2.0.0",
    "1.0.0-rc.1",
    "1.0.0garbage",
    "1.0.01",
    "not-semver",
  ])("rejects Pi %s", (version) => {
    expect(isSupportedPiVersion(version)).toBe(false);
  });

  it("advertises the supported and tested versions", () => {
    expect(PI_COMPATIBILITY).toEqual({
      testedRange: "1.0.x",
      minimum: "1.0.0",
      maximumExclusive: "1.1.0",
      tested: ["1.0.0"],
    });
  });
});
