declare const __PI_THREADS_VERSION__: string | undefined;

export const PACKAGE_VERSION = "0.1.0";
export const VERSION =
  typeof __PI_THREADS_VERSION__ === "string" ? __PI_THREADS_VERSION__ : PACKAGE_VERSION;

export const PI_COMPATIBILITY = {
  testedRange: "0.75.x - 0.80.x",
  minimum: "0.75.0",
  maximumExclusive: "0.81.0",
  tested: ["0.75.5", "0.80.3"],
} as const;

export function isSupportedPiVersion(version: string): boolean {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 0 && minor >= 75 && minor <= 80;
}
