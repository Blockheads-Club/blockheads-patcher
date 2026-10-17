import { describe, it, expect } from 'vitest';
import { readZip, writeZip, setEntry, getEntry, locateEocd, ZipError, type ZipArchive, type ZipEntry } from '../src/zip';
import { lazyData, rawMethods } from '../src/zip/types';

const enc = new TextEncoder();
const dec = new TextDecoder();

function sample(): Uint8Array {
  const z: ZipArchive = { entries: [] };
  setEntry(z, { name: 'a.txt', data: enc.encode('hello hello hello hello'), method: 8 });
  setEntry(z, { name: 'b.bin', data: new Uint8Array([1, 2, 3]), method: 0 });
  return writeZip(z);
}
/** Returns a copy with `edit(dv, cdStart, eocdStart)` applied. */
function patched(edit: (dv: DataView, cd: number, eocd: number, b: Uint8Array) => void, bytes = sample()): Uint8Array {
  const b = bytes.slice();
  const l = locateEocd(b);
  edit(new DataView(b.buffer), l.cdOffset, l.eocdOffset, b);
  return b;
}

describe('readZip: end of central directory', () => {
  it('reads an empty archive (EOCD at offset 0)', () => {
    const empty = writeZip({ entries: [] });
    expect(empty.length).toBe(22);
    expect(readZip(empty).entries).toEqual([]);
  });

  it('skips an EOCD signature embedded in the archive comment', () => {
    const z: ZipArchive = { entries: [] };
    setEntry(z, { name: 'a', data: enc.encode('x'), method: 0 });
    // a fake EOCD whose comment length does not reach the end of the file
    const fake = new Uint8Array(22);
    new DataView(fake.buffer).setUint32(0, 0x06054b50, true);
    new DataView(fake.buffer).setUint16(20, 7, true);
    z.comment = fake;
    const out = readZip(writeZip(z));
    expect(out.entries.map((e) => e.name)).toEqual(['a']);
    expect(out.comment).toEqual(fake);
  });

  it('rejects zip64 locators, zip64 sentinels and an out-of-bounds central directory', () => {
    const base = sample();
    // zip64 end-of-central-directory locator signature in the 20 bytes before the EOCD
    const withLocator = new Uint8Array(base.length + 20);
    const l = locateEocd(base);
    withLocator.set(base.subarray(0, l.eocdOffset));
    new DataView(withLocator.buffer).setUint32(l.eocdOffset, 0x07064b50, true);
    withLocator.set(base.subarray(l.eocdOffset), l.eocdOffset + 20);
    expect(() => readZip(withLocator)).toThrow(/zip64/);
    expect(() => readZip(patched((dv, _c, e) => dv.setUint16(e + 10, 0xffff, true)))).toThrow(/zip64/);
    expect(() => readZip(patched((dv, _c, e) => dv.setUint32(e + 12, 0xffffffff, true)))).toThrow(/zip64/);
    expect(() => readZip(patched((dv, _c, e) => dv.setUint32(e + 16, 0xffffffff, true)))).toThrow(/zip64/);
    expect(() => readZip(patched((dv, _c, e) => dv.setUint32(e + 12, 0x7fffffff, true)))).toThrow(/out of bounds/);
  });
});

describe('readZip: central directory entries', () => {
  it('rejects bad signatures and overruns', () => {
    expect(() => readZip(patched((dv, c) => dv.setUint32(c, 0, true)))).toThrow(/bad central directory entry #0/);
    expect(() => readZip(patched((dv, c) => dv.setUint16(c + 28, 0xffff, true)))).toThrow(/overruns/);
    // claims more entries than the directory holds -> the next record would start inside the EOCD
    expect(() => readZip(patched((dv, _c, e) => dv.setUint16(e + 10, 5, true)))).toThrow(/bad central directory entry/);
  });

  it('rejects zip64 entry fields, encryption, unknown methods and duplicates', () => {
    expect(() => readZip(patched((dv, c) => dv.setUint32(c + 20, 0xffffffff, true)))).toThrow(/zip64 entries/);
    expect(() => readZip(patched((dv, c) => dv.setUint32(c + 24, 0xffffffff, true)))).toThrow(/zip64 entries/);
    expect(() => readZip(patched((dv, c) => dv.setUint32(c + 42, 0xffffffff, true)))).toThrow(/zip64 entries/);
    expect(() => readZip(patched((dv, c) => dv.setUint16(c + 8, 1, true)))).toThrow(/encrypted entry not supported: a\.txt/);
    expect(() => readZip(patched((dv, c) => dv.setUint16(c + 10, 12, true)))).toThrow(/unsupported compression method 12: a\.txt/);
    // rename the second entry to the first one's name (same length) in the central directory
    const eq: ZipArchive = { entries: [] };
    setEntry(eq, { name: 'aaaa', data: new Uint8Array(1), method: 0 });
    setEntry(eq, { name: 'bbbb', data: new Uint8Array(1), method: 0 });
    const dupBytes = patched((_dv, c, _e, raw) => raw.set(enc.encode('aaaa'), c + 46 + 4 + 46), writeZip(eq));
    expect(() => readZip(dupBytes)).toThrow(/duplicate entry: aaaa/);
  });

  it('rejects bad local headers, out-of-bounds data and stored size mismatches', () => {
    expect(() => readZip(patched((dv, c) => dv.setUint32(c + 42, 0x7fffff00, true)))).toThrow(/bad local header for a\.txt/);
    expect(() => readZip(patched((dv, c) => dv.setUint32(c + 42, 3, true)))).toThrow(/bad local header for a\.txt/);
    expect(() => readZip(patched((dv, c) => dv.setUint32(c + 20, 0x00ffff00, true)))).toThrow(/entry data out of bounds: a\.txt/);
    // second entry (stored): compressed size no longer equals the size
    expect(() => readZip(patched((dv, c) => {
      const second = c + 46 + 5;
      dv.setUint32(second + 24, 99, true);
    }))).toThrow(/stored entry size mismatch: b\.bin/);
  });

  it('keeps entry comments and local extra fields', () => {
    const z: ZipArchive = { entries: [] };
    setEntry(z, { name: 'c.txt', data: enc.encode('data data data data'), method: 8, comment: 'a comment ü', extra: Uint8Array.of(0xaa, 0xbb, 0, 0) });
    const out = readZip(writeZip(z));
    expect(out.entries[0]!.comment).toBe('a comment ü');
    expect(Array.from(out.entries[0]!.extra!)).toEqual([0xaa, 0xbb, 0, 0]);
    expect(out.entries[0]!.flags & 0x800).toBe(0x800);
  });
});

describe('readZip: entry payloads', () => {
  it('handles empty deflated entries without inflating', () => {
    const z: ZipArchive = { entries: [] };
    setEntry(z, { name: 'empty', data: new Uint8Array(0), method: 8 });
    const out = readZip(writeZip(z));
    expect(out.entries[0]!.data.length).toBe(0);
  });

  it('reports CRC mismatches for stored and deflated entries', () => {
    expect(() => readZip(patched((dv, c) => dv.setUint32(c + 16, 1, true))).entries[0]!.data).toThrow(/CRC mismatch: a\.txt/);
    expect(() => readZip(patched((dv, c) => dv.setUint32(c + 46 + 5 + 16, 1, true))).entries[1]!.data).toThrow(/CRC mismatch: b\.bin/);
  });

  it('assigning data replaces the lazy loader', () => {
    const z = readZip(sample());
    const e = getEntry(z, 'a.txt')!;
    expect(lazyData.has(e)).toBe(true);
    e.data = enc.encode('new');
    expect(lazyData.has(e)).toBe(false);
    expect(dec.decode(e.data)).toBe('new');
  });
});

describe('writeZip', () => {
  it('re-stores a deflated entry whose method was changed (no copy-through)', () => {
    const z = readZip(sample());
    const a = getEntry(z, 'a.txt')!;
    expect(rawMethods.get(a)).toBe(8);
    a.method = 0;
    const out = readZip(writeZip(z));
    const ra = getEntry(out, 'a.txt')!;
    expect(ra.method).toBe(0);
    expect(dec.decode(ra.data)).toBe('hello hello hello hello');
  });

  it('re-stores an entry whose materialized data changed length or content', () => {
    const z = readZip(sample());
    const a = getEntry(z, 'a.txt')!;
    a.data = enc.encode('shorter');
    const b = getEntry(z, 'b.bin')!;
    const copy = b.data.slice();
    copy[0] = 0xee; // same length, different crc
    b.data = copy;
    const out = readZip(writeZip(z));
    expect(dec.decode(getEntry(out, 'a.txt')!.data)).toBe('shorter');
    expect(Array.from(getEntry(out, 'b.bin')!.data)).toEqual([0xee, 2, 3]);
    // materialized but unchanged entries are still copied through
    const z2 = readZip(sample());
    const keep = getEntry(z2, 'a.txt')!;
    void keep.data;
    const again = readZip(writeZip(z2));
    expect(Array.from(getEntry(again, 'a.txt')!.raw!.compressed)).toEqual(Array.from(keep.raw!.compressed));
  });

  it('honours custom alignment, including alignment 1 (no padding)', () => {
    const z: ZipArchive = { entries: [] };
    setEntry(z, { name: 'x.bin', data: new Uint8Array(5).fill(1), method: 0 });
    setEntry(z, { name: 'lib/x.so', data: new Uint8Array(5).fill(2), method: 0 });
    const noPad = writeZip(z, { alignment: 1, soAlignment: 1 });
    const dv = new DataView(noPad.buffer);
    expect(dv.getUint16(28, true)).toBe(0); // first local header: extra length 0
    const aligned = writeZip(z, { alignment: 16, soAlignment: 64 });
    const entries = readZip(aligned).entries;
    expect(entries).toHaveLength(2);
    expect(aligned.length).toBeGreaterThan(noPad.length);
  });

  it('writes entry comments and non-ASCII comments with the UTF-8 flag', () => {
    const z: ZipArchive = { entries: [] };
    setEntry(z, { name: 'plain', data: enc.encode('x'), method: 0, comment: 'ascii' });
    setEntry(z, { name: 'plain2', data: enc.encode('x'), method: 0, comment: 'ünï' });
    const out = readZip(writeZip(z));
    expect(out.entries.map((e) => e.comment)).toEqual(['ascii', 'ünï']);
    expect(out.entries.map((e) => e.flags & 0x800)).toEqual([0, 0x800]);
  });

  it('rejects archives that cannot be represented without zip64', () => {
    const e: ZipEntry = { name: 'a', method: 0, data: new Uint8Array(0), modTime: 0, modDate: 0x21, externalAttrs: 0, versionMadeBy: 20, flags: 0 };
    expect(() => writeZip({ entries: Array.from({ length: 0xffff }, () => e) })).toThrow(/too many entries/);

    // a "copy-through" entry whose declared sizes are huge: nothing is allocated
    const fake = (compressedLength: number, size: number): ZipEntry => {
      const entry: ZipEntry = { ...e, method: 8, raw: { compressed: { length: compressedLength } as unknown as Uint8Array, crc32: 0, uncompressedSize: size } };
      rawMethods.set(entry, 8);
      lazyData.set(entry, () => new Uint8Array(0));
      return entry;
    };
    expect(() => writeZip({ entries: [fake(0xffffff00, 1)] })).toThrow(/archive too large/);
    expect(() => writeZip({ entries: [fake(1, 0x100000000)] })).toThrow(/archive too large/);
  });

  it('rejects oversized names, comments and extra fields', () => {
    const base: ZipEntry = { name: 'a', method: 8, data: new Uint8Array(1), modTime: 0, modDate: 0x21, externalAttrs: 0, versionMadeBy: 20, flags: 0 };
    expect(() => writeZip({ entries: [{ ...base, name: 'n'.repeat(0x10000) }] })).toThrow(/name\/comment too long/);
    expect(() => writeZip({ entries: [{ ...base, comment: 'c'.repeat(0x10000) }] })).toThrow(/name\/comment too long/);
    expect(() => writeZip({ entries: [{ ...base, extra: new Uint8Array(0x10000) }] })).toThrow(/extra field too long/);
    expect(() => writeZip({ entries: [{ ...base, extra: new Uint8Array(0x10000) }] })).toThrow(ZipError);
  });
});
