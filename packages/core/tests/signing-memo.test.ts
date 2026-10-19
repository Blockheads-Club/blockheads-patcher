import { describe, it, expect, beforeAll } from 'vitest';
import { generateIdentity, loadApk, readZip, rememberEntryDigests, v1Files, type SigningIdentity } from '../src/index';
import { sourceOffsets } from '../src/zip/types';
import { makeApk } from './synthetic-apk';

const manifestText = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\r\n /g, '');
const digestOf = (mf: Uint8Array, name: string) => new RegExp(`Name: ${name}\r\n[^:]+-Digest: (\\S+)`).exec(manifestText(mf))?.[1];

describe('v1 digest memo', () => {
  let identity: SigningIdentity;
  beforeAll(async () => { identity = await generateIdentity(); }, 30_000);
  const bytes = makeApk();

  it('reuses digests of untouched entries of the same APK, never of read or edited ones', async () => {
    const apk = await loadApk(bytes);
    const blob = apk.zip.entries.find((e) => e.name === 'assets/blob.bin')!;
    const dex = apk.zip.entries.find((e) => e.name === 'classes.dex')!;
    const first = (await v1Files(apk.zip, { identity })).manifest;
    const real = digestOf(first, 'assets/blob.bin');
    expect(real).toMatch(/=$/);

    // A second load of the same bytes hits the memo: a seeded value shows up for an untouched entry ...
    rememberEntryDigests(apk.info.sha256, 'SHA-256', [[sourceOffsets.get(blob)!, 'SEEDED'], [sourceOffsets.get(dex)!, 'SEEDED-DEX']]);
    const again = await loadApk(bytes);
    again.zip.entries.find((e) => e.name === 'classes.dex')!.data; // ... but not for an entry that was read
    const second = (await v1Files(again.zip, { identity })).manifest;
    expect(digestOf(second, 'assets/blob.bin')).toBe('SEEDED');
    expect(digestOf(second, 'classes.dex')).toBe(digestOf(first, 'classes.dex'));

    // The legacy SHA-1 digests are kept apart.
    expect(digestOf((await v1Files((await loadApk(bytes)).zip, { identity, minSdk: 9 })).manifest, 'assets/blob.bin')).not.toBe('SEEDED');

    // Archives read without loadApk have no identity and never use the memo.
    expect(digestOf((await v1Files(readZip(bytes), { identity })).manifest, 'assets/blob.bin')).toBe(real);
  });

  it('keeps the digests of the four most recently used APKs', async () => {
    const apk = await loadApk(bytes);
    const off = sourceOffsets.get(apk.zip.entries.find((e) => e.name === 'assets/blob.bin')!)!;
    rememberEntryDigests(apk.info.sha256, 'SHA-256', [[off, 'OLD']]);
    expect(digestOf((await v1Files((await loadApk(bytes)).zip, { identity })).manifest, 'assets/blob.bin')).toBe('OLD');
    for (const n of [1, 2, 3, 4]) rememberEntryDigests(`other-${n}`, 'SHA-256', []);
    expect(digestOf((await v1Files((await loadApk(bytes)).zip, { identity })).manifest, 'assets/blob.bin')).not.toBe('OLD');
  });
});
