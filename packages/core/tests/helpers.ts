import { existsSync, readFileSync } from 'node:fs';

/** True when the user-owned APK exists. Set BH_SKIP_REAL=1 to run synthetic tests only (coverage must not depend on them). */
export const haveFile = (path: string): boolean => !process.env.BH_SKIP_REAL && existsSync(path);

/** Like haveFile, but also requires a readable zip end-of-central-directory record (skips truncated downloads). */
export const haveApk = (path: string): boolean => {
  if (!haveFile(path)) return false;
  const buf = readFileSync(path);
  const ok = buf.subarray(Math.max(0, buf.length - 0x10016)).includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  /* c8 ignore next */
  if (!ok) console.warn(`[tests] ${path} exists but is not a valid zip (no EOCD): its real-APK tests are SKIPPED`);
  return ok;
};
