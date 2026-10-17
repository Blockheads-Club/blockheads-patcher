import { describe, it, expect } from 'vitest';
import { readZip, writeZip, setEntry, ZipError, type ZipArchive } from '../src/zip';
import {
  generateIdentity, MemoryKeystore, getOrCreateIdentity, exportIdentityEncrypted, importIdentity, isEncryptedBundle,
  SigningError,
} from '../src/signing';

const enc = new TextEncoder();

describe('zip CRC verification', () => {
  for (const method of [0, 8] as const) {
    it(`rejects corrupted data (method ${method})`, () => {
      const zip: ZipArchive = { entries: [] };
      setEntry(zip, { name: 'a.txt', data: enc.encode('hello world hello world'), method });
      const bytes = writeZip(zip);
      expect(readZip(bytes).entries[0]!.data.length).toBe(23);
      const bad = bytes.slice();
      if (method === 0) {
        const dv = new DataView(bad.buffer);
        bad[30 + dv.getUint16(26, true) + dv.getUint16(28, true)]! ^= 1; // first data byte
      }
      else {
        // corrupt the CRC in the central directory instead: deflate streams may fail earlier or not
        const dv = new DataView(bad.buffer);
        const cd = dv.getUint32(bad.length - 22 + 16, true);
        dv.setUint32(cd + 16, dv.getUint32(cd + 16, true) ^ 1, true);
      }
      // entries inflate lazily, so corruption surfaces when the data is read
      expect(() => readZip(bad).entries[0]!.data).toThrow(ZipError);
    });
  }
});

describe('getOrCreateIdentity', () => {
  it('serializes concurrent creation', async () => {
    const ks = new MemoryKeystore();
    const [a, b, c] = await Promise.all([getOrCreateIdentity(ks), getOrCreateIdentity(ks), getOrCreateIdentity(ks)]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(await ks.get()).toBe(a);
  });
});

describe('encrypted identity export', () => {
  it('round-trips with the right passphrase and rejects the wrong one', async () => {
    const id = await generateIdentity();
    const bundle = await exportIdentityEncrypted(id, 'correct horse', 1000);
    expect(bundle.version).toBe(2);
    expect(JSON.stringify(bundle)).not.toContain('pkcs8');
    expect(isEncryptedBundle(JSON.stringify(bundle))).toBe(true);
    const back = await importIdentity(bundle, 'correct horse');
    expect(Array.from(back.certificateDer)).toEqual(Array.from(id.certificateDer));
    await expect(importIdentity(bundle, 'wrong')).rejects.toBeInstanceOf(SigningError);
    await expect(importIdentity(bundle)).rejects.toBeInstanceOf(SigningError);
  });
});
