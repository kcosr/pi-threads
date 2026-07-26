declare const __PI_THREADS_VERSION__: string | undefined;

export const PACKAGE_VERSION = "0.1.0";
export const VERSION =
  typeof __PI_THREADS_VERSION__ === "string" ? __PI_THREADS_VERSION__ : PACKAGE_VERSION;

export const PI_COMPATIBILITY = {
  testedRange: "0.75.x - 0.82.x",
  minimum: "0.75.0",
  maximumExclusive: "0.83.0",
  tested: ["0.75.5", "0.80.3", "0.82.1"],
} as const;

export function isSupportedPiVersion(version: string): boolean {
  const parsed = parsePiVersion(version);
  return parsed?.major === 0 && parsed.minor >= 75 && parsed.minor <= 82;
}

export function usesAgentSettledEvent(version: string | undefined): boolean {
  const parsed = version ? parsePiVersion(version) : undefined;
  return parsed?.major === 0 && parsed.minor >= 81;
}

function parsePiVersion(
  version: string,
): { major: number; minor: number; patch: number } | undefined {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}
