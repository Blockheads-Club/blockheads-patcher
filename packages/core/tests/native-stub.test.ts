import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { makeNativeStubPatch, BX_LR, PatchError, type PatchContext, type NativeStubSpec } from '../src/patches';
import { parseElfSegments, vaddrToFileOffset, sha256HexSync } from '../src/index';
import { setEntry, getEntry, type ZipArchive } from '../src/zip';

/** Builds a tiny ELF32 (or 64) with one PT_LOAD where vaddr = offset + delta. */
function elf(opts: { is64?: boolean; delta?: number; big?: boolean; truncate?: boolean } = {}): Uint8Array {
  const is64 = !!opts.is64, ehs = is64 ? 64 : 52, phs = is64 ? 56 : 32, size = 0x200;
  const b = new Uint8Array(size), dv = new DataView(b.buffer);
  b.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, opts.big ? 2 : 1, 1]);
  if (is64) { dv.setBigUint64(32, BigInt(ehs), true); dv.setUint16(54, phs, true); dv.setUint16(56, opts.truncate ? 200 : 1, true); }
  else { dv.setUint32(28, ehs, true); dv.setUint16(42, phs, true); dv.setUint16(44, opts.truncate ? 200 : 1, true); }
  const p = ehs, delta = opts.delta ?? 0;
  if (is64) {
    dv.setUint32(p, 1, true); dv.setBigUint64(p + 8, 0n, true); dv.setBigUint64(p + 16, BigInt(delta), true);
    dv.setBigUint64(p + 32, BigInt(size), true); dv.setBigUint64(p + 40, BigInt(size), true);
  } else {
    dv.setUint32(p, 1, true); dv.setUint32(p + 4, 0, true); dv.setUint32(p + 8, delta, true);
    dv.setUint32(p + 16, size, true); dv.setUint32(p + 20, size, true);
  }
  dv.setUint32(0x100, 0xe92d4df0, true);
  dv.setUint32(0x140, 0xe92d4df0, true);
  return b;
}
const LIB = 'lib/x.so';
const spec = (lib: Uint8Array, over: Partial<NativeStubSpec> = {}): NativeStubSpec => ({
  id: 'fix-test', packageName: 'p', versionCode: 5, versionName: '5', libPath: LIB,
  libSha256: createHash('sha256').update(lib).digest('hex'), addresses: [0x1000 + 0x100, 0x1000 + 0x140], original: 0xe92d4df0, ...over,
});
const ctx = (lib: Uint8Array | null, versionCode = 5): PatchContext => {
  const zip: ZipArchive = { entries: [] };
  if (lib) setEntry(zip, { name: LIB, data: lib });
  return { zip, manifest: null as never, info: { packageName: 'p', versionCode, sha256: '' }, markManifestDirty() {}, log() {} };
};

describe('sha256HexSync', () => {
  it('matches node for assorted lengths', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000]) {
      const d = new Uint8Array(n).map((_, i) => (i * 7 + 3) & 255);
      expect(sha256HexSync(d)).toBe(createHash('sha256').update(d).digest('hex'));
    }
  });
});

describe('truncated library', () => {
  it('is incompatible (not a throw) when PT_LOAD claims more bytes than the entry has', () => {
    const lib = elf();
    const short = lib.slice(0, 0x120);
    const p = makeNativeStubPatch(spec(short));
    expect(p.detect(ctx(short))).toBe('incompatible');
  });
});

describe('elf', () => {
  it('maps vaddr to file offset (32/64 bit)', () => {
    for (const is64 of [false, true]) {
      const segs = parseElfSegments(elf({ is64, delta: 0x1000 }));
      expect(vaddrToFileOffset(segs, 0x1100)).toBe(0x100);
      expect(vaddrToFileOffset(segs, 0x1000 + 0x1fe, 4)).toBeUndefined();
      expect(vaddrToFileOffset(segs, 0x50)).toBeUndefined();
    }
  });
  it('rejects bad input', () => {
    expect(() => parseElfSegments(new Uint8Array(10))).toThrow('not an ELF');
    expect(() => parseElfSegments(elf({ big: true }))).toThrow('little-endian');
    expect(() => parseElfSegments(elf({ truncate: true }))).toThrow('truncated');
  });
});

describe('makeNativeStubPatch', () => {
  it('detects, applies and re-detects', () => {
    const lib = elf({ delta: 0x1000 });
    const p = makeNativeStubPatch(spec(lib));
    expect(p.nameKey).toBe('patch.fix-test.name');
    const c = ctx(lib);
    expect(p.detect(c)).toBe('notApplied');
    p.apply(c);
    expect(p.detect(c)).toBe('applied');
    const out = getEntry(c.zip, LIB)!.data;
    expect(new DataView(out.buffer, out.byteOffset).getUint32(0x100, true)).toBe(BX_LR);
    expect(new DataView(lib.buffer).getUint32(0x100, true)).toBe(0xe92d4df0); // input untouched
    expect(() => p.apply(c)).toThrow(PatchError);
  });
  it('is incompatible on wrong version, missing lib, bad ELF, unmapped address, hash or word mismatch', () => {
    const lib = elf({ delta: 0x1000 });
    const p = makeNativeStubPatch(spec(lib));
    expect(p.detect(ctx(lib, 6))).toBe('incompatible');
    expect(p.detect(ctx(null))).toBe('incompatible');
    expect(p.detect(ctx(new Uint8Array(100)))).toBe('incompatible');
    expect(makeNativeStubPatch(spec(lib, { addresses: [0x9000] })).detect(ctx(lib))).toBe('incompatible');
    expect(makeNativeStubPatch(spec(lib, { libSha256: '00' })).detect(ctx(lib))).toBe('incompatible');
    const bad = lib.slice(); new DataView(bad.buffer).setUint32(0x140, 1, true);
    expect(makeNativeStubPatch(spec(bad)).detect(ctx(bad))).toBe('incompatible');
    expect(() => p.apply(ctx(null))).toThrow(PatchError);
  });
});
