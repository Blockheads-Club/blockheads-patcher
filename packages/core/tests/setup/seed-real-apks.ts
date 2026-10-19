/** Vitest setupFile: seeds the v1 digest memo of this worker with the digests global-real-apks.ts computed once. */
import { inject } from 'vitest';
import { rememberEntryDigests } from '../../src/signing';

for (const apk of inject('realApkDigests') ?? []) {
  rememberEntryDigests(apk.sha256, 'SHA-256', apk.digests['SHA-256']);
  rememberEntryDigests(apk.sha256, 'SHA1', apk.digests.SHA1);
}
