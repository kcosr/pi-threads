declare const __PI_THREADS_VERSION__: string | undefined;

export const PACKAGE_VERSION = "0.1.0";
export const VERSION =
  typeof __PI_THREADS_VERSION__ === "string" ? __PI_THREADS_VERSION__ : PACKAGE_VERSION;

export const PI_COMPATIBILITY = {
  testedRange: "1.0.x",
  minimum: "1.0.0",
  maximumExclusive: "1.1.0",
  tested: ["1.0.0"],
} as const;

export function isSupportedPiVersion(version: string): boolean {
  return /^1\.0\.(0|[1-9]\d*)(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.test(version.trim());
}
