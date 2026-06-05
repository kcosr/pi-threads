export const VERSION = "0.1.0";

export const PI_COMPATIBILITY = {
  testedRange: "0.75.x",
  minimum: "0.75.0",
  maximumExclusive: "0.76.0",
  tested: ["0.75.5"],
} as const;

export function isSupportedPiVersion(version: string): boolean {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 0 && minor === 75;
}
