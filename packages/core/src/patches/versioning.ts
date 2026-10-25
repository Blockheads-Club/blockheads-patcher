/**
 * Patch versions are plain integers: a bigger one is newer. Built-in patches count 1, 2, 3, ... (see
 * docs/development.md for when to bump). Patches that follow a semantic version (a pack, the mod loader build) map
 * `major.minor.patch` onto one integer with {@link semverToVersion}, so the same comparison works everywhere.
 */

const SEMVER = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** `major.minor.patch` (each part 0-999) as `major * 1_000_000 + minor * 1_000 + patch`; undefined when it is not that shape. */
export function semverToVersion(s: string): number | undefined {
  const m = SEMVER.exec(s);
  return m ? Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]) : undefined;
}

/** Inverse of {@link semverToVersion}. */
export const versionToSemver = (v: number): string => `${Math.floor(v / 1_000_000)}.${Math.floor(v / 1_000) % 1_000}.${v % 1_000}`;

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. */
export const comparePatchVersions = (a: number, b: number): number => a - b;

/** True for a usable patch version: a positive safe integer. */
export const isPatchVersion = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
