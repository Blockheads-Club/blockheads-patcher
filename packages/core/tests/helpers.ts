import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import type { ZipEntry } from '../src/zip';

/** The user-owned game APKs the real-APK tests run against (absent ones are skipped). */
export const REAL_APKS = {
  '1.7.4': '/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk',
  '1.7.5': '/home/kahverengi/Downloads/The Blockheads_1.7.5_APKPure.apk',
  '1.7.6': process.env.BH_APK_176 ?? '/home/kahverengi/Downloads/The Blockheads_1.7.6.apk',
} as const;
export type RealVersion = keyof typeof REAL_APKS;

/** True when the user-owned APK exists. Set BH_SKIP_REAL=1 to run synthetic tests only (coverage must not depend on them). */
export const haveFile = (path: string): boolean => !process.env.BH_SKIP_REAL && existsSync(path);

/** Game version of a real APK path (`1.7.x`), from REAL_APKS or the file name. */
export function versionOf(path: string): string | undefined {
  const known = (Object.keys(REAL_APKS) as RealVersion[]).find((v) => REAL_APKS[v] === path);
  return known ?? /1\.7\.\d+/.exec(basename(path))?.[0];
}

/**
 * True when the real-APK tests of this version run: BH_REAL_VERSIONS="1.7.6" (comma or space separated) limits them to
 * those versions (the fast, non-gating tier; see `bun run test:fast`). Unset = all versions.
 */
export function wantVersion(path: string): boolean {
  const only = process.env.BH_REAL_VERSIONS?.split(/[\s,]+/).filter(Boolean);
  if (!only?.length) return true;
  const v = versionOf(path);
  return v !== undefined && only.includes(v);
}

const apkOk = new Map<string, boolean>();

/** Like haveFile (and wantVersion), but also requires a zip end-of-central-directory record (skips truncated downloads). */
export const haveApk = (path: string): boolean => {
  if (!haveFile(path) || !wantVersion(path)) return false;
  let ok = apkOk.get(path);
  if (ok === undefined) {
    // only the tail: the EOCD record sits in the last 64 KiB + 22 bytes
    const fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 0x10016));
    readSync(fd, tail, 0, tail.length, size - tail.length);
    closeSync(fd);
    ok = tail.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    apkOk.set(path, ok);
    /* c8 ignore next */
    if (!ok) console.warn(`[tests] ${path} exists but is not a valid zip (no EOCD): its real-APK tests are SKIPPED`);
  }
  return ok;
};

/** Same uncompressed content. Compares the stored bytes first (entries copied through unchanged) and inflates only when they differ. */
export function sameContent(a: ZipEntry, b: ZipEntry): boolean {
  if (a.raw && b.raw && a.method === b.method && a.raw.crc32 === b.raw.crc32 && Buffer.compare(a.raw.compressed, b.raw.compressed) === 0) return true;
  return Buffer.compare(a.data, b.data) === 0;
}
