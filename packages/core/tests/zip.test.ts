import { haveApk, haveFile } from './helpers';
import { describe, expect, test, onTestFinished } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ZipArchive, readZip, writeZip, getEntry, setEntry, removeEntry, removeSignatureFiles, crc32, locateEocd, ZipError,
} from '../src/zip';

const enc = new TextEncoder();
const APK = '/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk';
const ZIPALIGN = join(homedir(), 'Android/Sdk/build-tools/35.0.0/zipalign');

function sample() {
  const zip: ZipArchive = { entries: [] };
  setEntry(zip, { name: 'a.txt', data: enc.encode('hello hello hello hello'), method: 8 });
  setEntry(zip, { name: 'dir/', data: new Uint8Array(0), method: 0 });
  setEntry(zip, { name: 'res/raw.bin', data: new Uint8Array([1, 2, 3, 4, 5]), method: 0 });
  setEntry(zip, { name: 'lib/arm64-v8a/libx.so', data: new Uint8Array(100).fill(7), method: 0 });
  setEntry(zip, { name: 'ünï.txt', data: enc.encode('x'), method: 8 });
  return zip;
}

describe('crc32', () => {
  test('known vector', () => expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926));
});

describe('zip synthetic', () => {
  test('round trip keeps order, data, methods', () => {
    const out = readZip(writeZip(sample()));
    expect(out.entries.map((e) => e.name)).toEqual(['a.txt', 'dir/', 'res/raw.bin', 'lib/arm64-v8a/libx.so', 'ünï.txt']);
    expect(out.entries.map((e) => e.method)).toEqual([8, 0, 0, 0, 8]);
    expect(new TextDecoder().decode(getEntry(out, 'a.txt')!.data)).toBe('hello hello hello hello');
    expect(getEntry(out, 'ünï.txt')!.flags & 0x800).toBe(0x800);
  });

  test('STORED entries are aligned (4 and 4096 for .so)', () => {
    const bytes = writeZip(sample());
    const dv = new DataView(bytes.buffer);
    let p = 0;
    for (const e of readZip(bytes).entries) {
      // find local header by scanning in order
      while (dv.getUint32(p, true) !== 0x04034b50) p++;
      const start = p + 30 + dv.getUint16(p + 26, true) + dv.getUint16(p + 28, true);
      if (e.method === 0 && !e.name.endsWith('/')) expect(start % (e.name.endsWith('.so') ? 4096 : 4)).toBe(0);
      p = start + (e.raw?.compressed.length ?? 0);
    }
  });

  test('copy-through preserves compressed bytes; modified data is recompressed', () => {
    const z = readZip(writeZip(sample()));
    const a = getEntry(z, 'a.txt')!;
    const rawBefore = a.raw!.compressed;
    const z2 = readZip(writeZip(z));
    expect(Array.from(getEntry(z2, 'a.txt')!.raw!.compressed)).toEqual(Array.from(rawBefore));
    setEntry(z, { name: 'a.txt', data: enc.encode('changed') });
    const z3 = readZip(writeZip(z));
    expect(getEntry(z3, 'a.txt')!.method).toBe(8);
    expect(new TextDecoder().decode(getEntry(z3, 'a.txt')!.data)).toBe('changed');
  });

  test('in-place mutation of data is detected', () => {
    const z = readZip(writeZip(sample()));
    getEntry(z, 'res/raw.bin')!.data = new Uint8Array([9, 9]);
    expect(Array.from(getEntry(readZip(writeZip(z)), 'res/raw.bin')!.data)).toEqual([9, 9]);
  });

  test('setEntry replace keeps position/method; remove', () => {
    const z = sample();
    setEntry(z, { name: 'res/raw.bin', data: new Uint8Array([0]) });
    expect(z.entries[2]!.name).toBe('res/raw.bin');
    expect(z.entries[2]!.method).toBe(0);
    expect(removeEntry(z, 'a.txt')).toBe(true);
    expect(removeEntry(z, 'nope')).toBe(false);
  });

  test('removeSignatureFiles', () => {
    const z = sample();
    for (const n of ['META-INF/MANIFEST.MF', 'META-INF/CERT.SF', 'META-INF/CERT.RSA', 'META-INF/X.DSA', 'META-INF/Y.EC', 'META-INF/SIG-FOO', 'META-INF/services/keep', 'META-INF/kotlin.kotlin_module'])
      setEntry(z, { name: n, data: new Uint8Array(1) });
    const removed = removeSignatureFiles(z);
    expect(removed.sort()).toEqual(['META-INF/CERT.RSA', 'META-INF/CERT.SF', 'META-INF/MANIFEST.MF', 'META-INF/SIG-FOO', 'META-INF/X.DSA', 'META-INF/Y.EC'].sort());
    expect(getEntry(z, 'META-INF/services/keep')).toBeDefined();
    expect(getEntry(z, 'META-INF/kotlin.kotlin_module')).toBeDefined();
  });

  test('errors', () => {
    expect(() => readZip(new Uint8Array(10))).toThrow(ZipError);
    expect(() => readZip(new Uint8Array(100))).toThrow(ZipError);
    const b = writeZip(sample());
    const bad = b.slice();
    bad[b.length - 22 + 10] = 0xff; bad[b.length - 22 + 11] = 0xff; // zip64 marker count
    expect(() => readZip(bad)).toThrow(/zip64/);
  });

  test('locateEocd and comment', () => {
    const z = sample();
    z.comment = enc.encode('hi');
    const b = writeZip(z);
    const l = locateEocd(b);
    expect(l.entryCount).toBe(5);
    expect(l.cdOffset + l.cdSize).toBe(l.eocdOffset);
    expect(new TextDecoder().decode(readZip(b).comment)).toBe('hi');
  });

  test('ignores data between entries and central directory (signing block)', () => {
    const b = writeZip(sample());
    const l = locateEocd(b);
    const block = new Uint8Array(64).fill(0x55);
    const out = new Uint8Array(b.length + 64);
    out.set(b.subarray(0, l.cdOffset), 0);
    out.set(block, l.cdOffset);
    out.set(b.subarray(l.cdOffset), l.cdOffset + 64);
    new DataView(out.buffer).setUint32(out.length - 22 + 16, l.cdOffset + 64, true);
    expect(readZip(out).entries.length).toBe(5);
  });
});

describe.skipIf(!haveApk(APK))('zip on real APK', () => {
  const input = haveApk(APK) ? new Uint8Array(readFileSync(APK)) : new Uint8Array(0);

  test('every entry survives read -> write -> read identically', () => {
    const a = readZip(input);
    const out = writeZip(a);
    const b = readZip(out);
    expect(b.entries.map((e) => e.name)).toEqual(a.entries.map((e) => e.name));
    for (let i = 0; i < a.entries.length; i++) {
      const x = a.entries[i]!, y = b.entries[i]!;
      expect(y.method).toBe(x.method);
      expect(y.raw!.crc32).toBe(x.raw!.crc32);
      expect(y.data.length).toBe(x.data.length);
      expect(crc32(y.data)).toBe(x.raw!.crc32);
    }
  }, 120_000);

  test('recompressed output also matches (force recompress)', () => {
    const a = readZip(input);
    // keep the sync deflate work bounded (a full recompress of ~100 MB blocks the worker > 60 s under v8 coverage)
    a.entries = a.entries.filter((e) => e.data.length <= 1_000_000);
    const orig = a.entries.map((e) => ({ n: e.name, c: e.raw!.crc32 }));
    for (const e of a.entries) delete e.raw;
    const b = readZip(writeZip(a));
    expect(b.entries.map((e) => ({ n: e.name, c: crc32(e.data) }))).toEqual(orig);
  }, 300_000);

  test.skipIf(!haveFile(ZIPALIGN))('zipalign -c -p and unzip -t accept output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bhzip-'));
    const f = join(dir, 'out.apk');
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(f, writeZip(readZip(input)));
    const r = spawnSync(ZIPALIGN, ['-c', '-p', '-v', '4', f], { encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const u = spawnSync('unzip', ['-tq', f], { encoding: 'utf8' });
    if (u.error === undefined) expect(u.status, u.stdout + u.stderr).toBe(0);
  }, 300_000);
});
