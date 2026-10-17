import { describe, it, expect } from 'vitest';
import { deflateSync, zipSync } from 'fflate';
import { readZip, writeZip, setEntry, peekData, getEntry, type ZipArchive } from '../src/zip';
import { signZip, generateIdentity } from '../src/signing';
import { CancelledError } from '../src/abort';

const enc = new TextEncoder();
const text = (n: number) => enc.encode('lorem ipsum dolor sit amet '.repeat(n));

function sample(): Uint8Array {
  const z: ZipArchive = { entries: [] };
  setEntry(z, { name: 'a.txt', data: text(50), method: 8 });
  setEntry(z, { name: 'b.bin', data: text(5), method: 0 });
  return writeZip(z);
}

describe('lazy zip entries', () => {
  it('keeps untouched entries byte-identical (compressed bytes copied verbatim)', () => {
    // A foreign deflate stream (level 1): recompressing at the writer's level 6 would change the bytes.
    const data = new Uint8Array(20000).map((_, i) => ((i * 2654435761) >>> 24) & (i % 7 ? 0x3f : 0xff));
    expect(Array.from(deflateSync(data, { level: 6 }))).not.toEqual(Array.from(deflateSync(data, { level: 1 })));
    const foreign = zipSync({ 'a.bin': [data, { level: 1 }] });
    const zip = readZip(foreign);
    const out = readZip(writeZip(zip));
    expect(Array.from(out.entries[0]!.raw!.compressed)).toEqual(Array.from(zip.entries[0]!.raw!.compressed));
  });

  it('does not inflate until data is read, and peekData does not cache', () => {
    const zip = readZip(sample());
    const e = getEntry(zip, 'a.txt')!;
    const d1 = peekData(e);
    const d2 = peekData(e);
    expect(d1).not.toBe(d2); // not retained
    expect(d1.length).toBe(text(50).length);
    const d3 = e.data;
    expect(e.data).toBe(d3); // cached once materialized
  });

  it('recompresses only changed entries', () => {
    const src = sample();
    const zip = readZip(src);
    const a = getEntry(zip, 'a.txt')!;
    const orig = a.raw!.compressed.slice();
    const changed = text(50);
    changed[0] = 0x58;
    a.data = changed;
    const out = readZip(writeZip(zip));
    expect(out.entries[0]!.data[0]).toBe(0x58);
    expect(out.entries[1]!.data).toEqual(text(5));
    expect(Array.from(out.entries[0]!.raw!.compressed)).not.toEqual(Array.from(orig));
  });

  it('detects in-place mutation of materialized data', () => {
    const zip = readZip(sample());
    const b = getEntry(zip, 'b.bin')!;
    b.data[0] = 0x7a; // stored entries expose a subarray of the source: copy first in real code, here mutate the view
    const out = readZip(writeZip(zip));
    expect(out.entries[1]!.data[0]).toBe(0x7a);
  });
});

describe('lazy zip errors surface on access', () => {
  const cdOf = (b: Uint8Array) => new DataView(b.buffer).getUint32(b.length - 22 + 16, true);

  it('reports a corrupt deflate stream', () => {
    const src = sample();
    const dv = new DataView(src.buffer);
    const bad = src.slice();
    const dataStart = 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
    bad.fill(0xff, dataStart, dataStart + 8);
    expect(() => readZip(bad).entries[0]!.data).toThrow(/cannot inflate a\.txt/);
  });

  it('reports an inflated size mismatch', () => {
    const bad = sample().slice();
    const dv = new DataView(bad.buffer);
    const cd = cdOf(bad);
    dv.setUint32(cd + 24, dv.getUint32(cd + 24, true) + 5, true); // claim 5 more bytes than the stream holds
    expect(() => readZip(bad).entries[0]!.data).toThrow(/a\.txt/);
  });
});

describe('cancellation', () => {
  it('signZip throws CancelledError when the signal is aborted', async () => {
    const zip = readZip(sample());
    const ac = new AbortController();
    ac.abort();
    await expect(signZip(zip, { identity: await generateIdentity(), signal: ac.signal })).rejects.toBeInstanceOf(CancelledError);
  });

  it('reports sign progress up to the v1 stage', async () => {
    const zip = readZip(sample());
    const seen: number[] = [];
    await signZip(zip, { identity: await generateIdentity(), onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBeLessThanOrEqual(1);
  });
});
