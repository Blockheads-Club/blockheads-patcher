import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ElfImage, PatchError, makeNativePatch, toOp, decodeArmBranch, decodeThumbBranch, type CodeBlock, type NativeEdit, type NativePatchSpec,
  type PatchContext,
} from '../src/index';
import { getEntry, setEntry, type ZipArchive } from '../src/zip';
import { buildElf, CODE, DATA, STR, type FixtureOptions } from './elf-fixture';

const LIB = 'lib/x.so';
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const ctxFor = (zip: ZipArchive, versionCode = 5): PatchContext =>
  ({ zip, manifest: null as never, info: { packageName: 'p', versionCode, sha256: '' }, markManifestDirty() {}, log() {} });
const zipWith = (lib: Uint8Array | null): ZipArchive => {
  const zip: ZipArchive = { entries: [] };
  if (lib) setEntry(zip, { name: LIB, data: lib });
  return zip;
};
const spec = (lib: Uint8Array, edits: NativeEdit[], over: Partial<NativePatchSpec> = {}, id = 'fix-t'): NativePatchSpec => ({
  id, packageName: 'p', libPath: LIB, versions: [{ versionCode: 5, versionName: '5', libSha256: sha(lib), edits }], ...over,
});
const img = (zip: ZipArchive): ElfImage => new ElfImage(getEntry(zip, LIB)!.data);
const u32 = (i: ElfImage, a: number): number => i.readU32(a)!;
const half = (i: ElfImage, a: number): number => i.read(a, 2)![0]! | (i.read(a, 2)![1]! << 8);

describe('makeNativePatch basics', () => {
  it('applies byte, ARM and Thumb edits and reports status', () => {
    const lib = buildElf();
    const edits: NativeEdit[] = [
      { kind: 'arm', vaddr: CODE, original: [0xe1a00000], replacement: [0xe12fff1e] },
      { kind: 'thumb', vaddr: CODE + 8, original: [0x0002, 0xe1a0], replacement: [0xbf00, 0xbf00] },
      { kind: 'bytes', vaddr: STR, original: [0x68], replacement: [0x48] },
    ];
    const p = makeNativePatch(spec(lib, edits, { optIn: true, credits: { source: 's', url: 'u' } }));
    expect(p.nameKey).toBe('patch.fix-t.name');
    expect(p.descriptionKey).toBe('patch.fix-t.description');
    expect(p.optIn).toBe(true);
    expect(p.credits).toEqual({ source: 's', url: 'u' });
    expect(p.appliesTo).toEqual({ packageName: 'p', versionCode: { min: 5, max: 5 }, versionNames: ['5'] });
    const zip = zipWith(lib);
    const c = ctxFor(zip);
    expect(p.detect(c)).toBe('notApplied');
    const logs: string[] = [];
    p.apply({ ...c, log: (m) => logs.push(m) });
    expect(logs).toHaveLength(1);
    expect(p.detect(c)).toBe('applied');
    const i = img(zip);
    expect(u32(i, CODE)).toBe(0xe12fff1e);
    expect(half(i, CODE + 8)).toBe(0xbf00);
    expect(i.readCString(STR)).toBe('Hello world');
    expect(() => p.apply(c)).toThrow(PatchError);
    expect(lib[STR]).toBe(0x68);
  });
  it('is incompatible on wrong version, missing or broken library, tampered bytes or hash', () => {
    const lib = buildElf();
    const edit: NativeEdit = { kind: 'arm', vaddr: CODE, original: [0xe1a00000], replacement: [0xe12fff1e] };
    const p = makeNativePatch(spec(lib, [edit]));
    expect(p.detect(ctxFor(zipWith(lib), 6))).toBe('incompatible');
    expect(p.detect(ctxFor(zipWith(null)))).toBe('incompatible');
    expect(p.detect(ctxFor(zipWith(new Uint8Array(10))))).toBe('incompatible');
    expect(() => p.apply(ctxFor(zipWith(null)))).toThrow(PatchError);
    expect(makeNativePatch(spec(lib, [edit], { versions: [{ versionCode: 5, versionName: '5', libSha256: '00', edits: [edit] }] })).detect(ctxFor(zipWith(lib)))).toBe('incompatible');
    const bad = lib.slice(); bad[CODE] = 1;
    expect(makeNativePatch(spec(bad, [edit])).detect(ctxFor(zipWith(bad)))).toBe('incompatible');
    const mixed = makeNativePatch(spec(lib, [edit, { kind: 'arm', vaddr: CODE + 4, original: [0xe1a00001], replacement: [0xe12fff1e] }]));
    const z = zipWith(lib);
    new ElfImage(lib); // unchanged
    const d = getEntry(z, LIB)!.data.slice(); new DataView(d.buffer).setUint32(CODE, 0xe12fff1e, true);
    setEntry(z, { name: LIB, data: d });
    expect(mixed.detect(ctxFor(z))).toBe('incompatible');
  });
  it('covers several versions in one patch', () => {
    const lib = buildElf();
    const e = (v: number): NativePatchSpec['versions'][number] =>
      ({ versionCode: v, versionName: String(v), libSha256: sha(lib), edits: [{ kind: 'arm', vaddr: CODE, original: [0xe1a00000], replacement: [0xe12fff1e] }] });
    const p = makeNativePatch({ id: 'multi', packageName: 'p', libPath: LIB, versions: [e(9), e(3)] });
    expect(p.appliesTo.versionCode).toEqual({ min: 3, max: 9 });
    expect(p.detect(ctxFor(zipWith(lib), 3))).toBe('notApplied');
    expect(p.detect(ctxFor(zipWith(lib), 4))).toBe('incompatible');
  });
  it('rejects malformed specs when the patch is built', () => {
    const lib = buildElf();
    const bad = (e: NativeEdit): void => expect(() => toOp(e)).toThrow();
    bad({ kind: 'arm', vaddr: CODE + 2, original: [1], replacement: [2] });
    bad({ kind: 'thumb', vaddr: CODE + 1, original: [1], replacement: [2] });
    bad({ kind: 'bytes', vaddr: CODE, original: [1], replacement: [] });
    bad({ kind: 'bytes', vaddr: CODE, original: [], replacement: [] });
    bad({ kind: 'string', vaddr: STR, original: 'a\0', replacement: 'b' });
    bad({ kind: 'string', vaddr: STR, original: 'a', replacement: 'long' });
    bad({ kind: 'cave', vaddr: CODE + 2, mode: 'arm', original: [0], code: { mode: 'arm', items: [] } });
    expect(() => makeNativePatch(spec(lib, [{ kind: 'bytes', vaddr: CODE, original: [1], replacement: [] }]))).toThrow();
  });
});

describe('stacking on one archive', () => {
  it('keeps the hash pin valid after another native patch changed the library', () => {
    const lib = buildElf();
    const a = makeNativePatch(spec(lib, [{ kind: 'arm', vaddr: CODE, original: [0xe1a00000], replacement: [0xe12fff1e] }], {}, 'a'));
    const b = makeNativePatch(spec(lib, [{ kind: 'arm', vaddr: CODE + 4, original: [0xe1a00001], replacement: [0xe12fff1e] }], {}, 'b'));
    const zip = zipWith(lib);
    const c = ctxFor(zip);
    expect(a.detect(c)).toBe('notApplied');
    a.apply(c);
    expect(b.detect(c)).toBe('notApplied');
    b.apply(c);
    expect(a.detect(c)).toBe('applied');
    expect(b.detect(c)).toBe('applied');
    // a fresh archive of the already patched library is not accepted for further patches
    const again = zipWith(getEntry(zip, LIB)!.data);
    const c2 = makeNativePatch(spec(lib, [{ kind: 'arm', vaddr: CODE + 8, original: [0xe1a00002], replacement: [0xe12fff1e] }], {}, 'c'));
    expect(c2.detect(ctxFor(again))).toBe('incompatible');
  });
});

const block = (mode: 'arm' | 'thumb', ...items: CodeBlock['items']): CodeBlock => ({ mode, items });
const armOrig = [0xe1a00000, 0xe1a00001];

describe('code caves', () => {
  const run = (edit: NativeEdit, opts?: FixtureOptions) => {
    const lib = buildElf(opts);
    const p = makeNativePatch(spec(lib, [edit]));
    const zip = zipWith(lib);
    const c = ctxFor(zip);
    expect(p.detect(c)).toBe('notApplied');
    p.apply(c);
    expect(p.detect(c)).toBe('applied');
    return { zip, p, c, lib };
  };
  it('branches from ARM to an ARM cave in padding and fills the rest with NOPs', () => {
    const { zip } = run({
      kind: 'cave', vaddr: CODE, mode: 'arm', original: [...armOrig, 0xe1a00002], link: false,
      code: block('arm', { op: 'arm', words: [0xe3a00007] }, { op: 'branch', to: CODE + 12 }),
    });
    const i = img(zip);
    const d = decodeArmBranch(u32(i, CODE), CODE)!;
    expect(d.mode).toBe('arm');
    expect(d.target).toBe(0x300);
    expect(u32(i, CODE + 4)).toBe(0xe1a00000);
    expect(u32(i, CODE + 8)).toBe(0xe1a00000);
    expect(u32(i, 0x300)).toBe(0xe3a00007);
    expect(decodeArmBranch(u32(i, 0x304), 0x304)!.target).toBe(CODE + 12);
  });
  it('supports conditional and linking ARM branches and a conditional skip', () => {
    const { zip } = run({
      kind: 'cave', vaddr: CODE, mode: 'arm', original: [0xe1a00000], link: true, cond: 1,
      code: block('arm', { op: 'branch', to: CODE + 4 }),
    });
    expect(decodeArmBranch(u32(img(zip), CODE), CODE)).toEqual({ target: 0x300, mode: 'arm', link: true });
  });
  it('branches from ARM to a Thumb cave with BLX and back', () => {
    const { zip } = run({
      kind: 'cave', vaddr: CODE, mode: 'arm', original: [0xe1a00000], link: true,
      code: block('thumb', { op: 'thumb', halfwords: [0x2007] }, { op: 'branch', to: CODE + 4, toMode: 'arm', link: true }),
    });
    const i = img(zip);
    expect(decodeArmBranch(u32(i, CODE), CODE)).toEqual({ target: 0x300, mode: 'thumb', link: true });
    expect(half(i, 0x300)).toBe(0x2007);
  });
  it('branches from Thumb: narrow B, B.W, BL and BLX', () => {
    const t = (original: number[], link: boolean, mode: 'arm' | 'thumb', items: CodeBlock['items']) =>
      run({ kind: 'cave', vaddr: CODE, mode: 'thumb', original, link, code: block(mode, ...items) });
    const narrow = t([0x0000], false, 'thumb', [{ op: 'thumb', halfwords: [0xbf00] }]);
    expect(decodeThumbBranch(half(img(narrow.zip), CODE), 0, CODE)).toMatchObject({ target: 0x300, mode: 'thumb', link: false, size: 2 });
    const wide = t([0x0000, 0xe1a0, 0x0001], false, 'thumb', [{ op: 'thumb', halfwords: [0xbf00] }]);
    const iw = img(wide.zip);
    expect(decodeThumbBranch(half(iw, CODE), half(iw, CODE + 2), CODE)).toMatchObject({ target: 0x300, link: false, size: 4 });
    expect(half(iw, CODE + 4)).toBe(0xbf00);
    const bl = t([0x0000, 0xe1a0], true, 'thumb', [{ op: 'thumb', halfwords: [0xbf00] }]);
    expect(decodeThumbBranch(half(img(bl.zip), CODE), half(img(bl.zip), CODE + 2), CODE)).toMatchObject({ link: true, mode: 'thumb' });
    const blx = t([0x0000, 0xe1a0], true, 'arm', [{ op: 'arm', words: [0xe12fff1e] }]);
    expect(decodeThumbBranch(half(img(blx.zip), CODE), half(img(blx.zip), CODE + 2), CODE)).toMatchObject({ link: true, mode: 'arm', target: 0x300 });
  });
  it('uses an appended segment when the padding is exhausted and aligns data', () => {
    const { zip } = run({
      kind: 'cave', vaddr: CODE, mode: 'arm', original: [0xe1a00000],
      code: block('arm', { op: 'align', to: 8 }, { op: 'arm', words: [1] }, { op: 'branch', to: CODE + 4 }),
    }, { junkAt: 0x304 });
    const target = decodeArmBranch(u32(img(zip), CODE), CODE)!.target;
    expect(target % 8).toBe(0);
    expect(target).toBeGreaterThanOrEqual(0x1300);
  });
  it('is incompatible when the cave or branch was tampered with, or region and branch disagree', () => {
    const { zip, p, c } = run({ kind: 'cave', vaddr: CODE, mode: 'arm', original: [0xe1a00000], code: block('arm', { op: 'arm', words: [0xe3a00007] }) });
    const good = getEntry(zip, LIB)!.data.slice();
    const t = (mutate: (d: Uint8Array, dv: DataView) => void): string => {
      const d = good.slice(); mutate(d, new DataView(d.buffer));
      setEntry(zip, { name: LIB, data: d });
      return p.detect(c);
    };
    expect(t((d) => { d[0x300] ^= 0xff; })).toBe('incompatible'); // cave code differs
    expect(t((_d, dv) => dv.setUint32(CODE, 0xe1a00005, true))).toBe('incompatible'); // not a branch
    expect(t((_d, dv) => dv.setUint32(CODE, 0xe12fff1e, true))).toBe('incompatible');
    expect(t((_d, dv) => dv.setUint32(CODE, 0xfa000000, true))).toBe('incompatible'); // Thumb target
    expect(t((_d, dv) => dv.setUint32(CODE, 0xea000000 | 0x7fffff, true))).toBe('incompatible'); // target outside the file
    expect(t((_d, dv) => dv.setUint32(CODE, 0x1a0000c0, true))).toBe('incompatible'); // conditional, wrong form
    setEntry(zip, { name: LIB, data: good.subarray(0, CODE + 2) });
    expect(p.detect(c)).toBe('incompatible');
  });
  it('treats an impossible branch form found at the site as not applied', () => {
    const lib = buildElf();
    const edit: NativeEdit = { kind: 'cave', vaddr: CODE, mode: 'arm', original: [0xe1a00000], code: block('thumb', { op: 'thumb', halfwords: [0xbf00] }) };
    const d = lib.slice(); new DataView(d.buffer).setUint32(CODE, 0xfa000040, true); // some BLX immediate
    const p = makeNativePatch(spec(lib, [edit]));
    expect(p.detect(ctxFor(zipWith(d)))).toBe('incompatible');
  });
  it('detects Thumb caves with trailing halfwords and rejects odd regions', () => {
    const { zip, p, c } = run({ kind: 'cave', vaddr: CODE, mode: 'thumb', original: [0x0000], code: block('thumb', { op: 'thumb', halfwords: [0xbf00] }) });
    const d = getEntry(zip, LIB)!.data.slice();
    new DataView(d.buffer).setUint16(CODE, 0xbf00, true);
    setEntry(zip, { name: LIB, data: d });
    expect(p.detect(c)).toBe('incompatible');
  });
  it('rejects impossible branch requests', () => {
    const lib = buildElf();
    const apply = (e: NativeEdit): void => makeNativePatch(spec(lib, [e])).apply(ctxFor(zipWith(lib)));
    const arm = (code: CodeBlock, over: object = {}): NativeEdit => ({ kind: 'cave', vaddr: CODE, mode: 'arm', original: [0xe1a00000], code, ...over });
    expect(() => apply(arm(block('thumb', { op: 'thumb', halfwords: [0xbf00] })))).toThrow('unconditional links');
    expect(() => apply({ kind: 'cave', vaddr: CODE, mode: 'thumb', original: [0x0000, 0xe1a0], cond: 1, code: block('thumb', { op: 'thumb', halfwords: [1] }) })).toThrow('conditional Thumb');
    expect(() => apply({ kind: 'cave', vaddr: CODE, mode: 'thumb', original: [0x0000, 0xe1a0], code: block('arm', { op: 'arm', words: [1] }) })).toThrow('links');
    expect(() => apply({ kind: 'cave', vaddr: CODE, mode: 'thumb', original: [0x0000], link: true, code: block('thumb', { op: 'thumb', halfwords: [1] }) })).toThrow('smaller than the branch');
  });
});

describe('string edits', () => {
  const edit = (replacement: string, over: Partial<Extract<NativeEdit, { kind: 'string' }>> = {}): NativeEdit => ({
    kind: 'string', vaddr: STR, original: 'hello world', replacement,
    pointers: [{ vaddr: DATA + 8, lengthVaddr: DATA + 12 }, { vaddr: DATA + 0x18, lengthVaddr: DATA + 0x1c }], ...over,
  });
  const apply = (e: NativeEdit, opts?: FixtureOptions) => {
    const lib = buildElf(opts);
    const p = makeNativePatch(spec(lib, [e]));
    const zip = zipWith(lib);
    const c = ctxFor(zip);
    expect(p.detect(c)).toBe('notApplied');
    p.apply(c);
    expect(p.detect(c)).toBe('applied');
    return { zip, p, c };
  };
  it('overwrites in place, pads with NULs and updates lengths', () => {
    const { zip } = apply(edit('hi there'));
    const i = img(zip);
    expect(i.readCString(STR)).toBe('hi there');
    expect(i.read(STR + 8, 4)).toEqual(new Uint8Array(4));
    expect(u32(i, DATA + 12)).toBe(8);
    expect(u32(i, DATA + 0x1c)).toBe(8);
    expect(u32(i, DATA + 8)).toBe(STR);
  });
  it('overwrites in place without pointers', () => {
    const { zip } = apply({ kind: 'string', vaddr: STR, original: 'hello world', replacement: 'bye' });
    expect(img(zip).readCString(STR)).toBe('bye');
    const { zip: z2 } = apply({ kind: 'string', vaddr: STR, original: 'hello world', replacement: 'bye', pointers: [{ vaddr: DATA + 8 }] });
    expect(img(z2).readCString(STR)).toBe('bye');
  });
  it('relocates a longer string and re-points every CFString', () => {
    const { zip, p, c } = apply(edit('hello wonderful world'));
    const i = img(zip);
    const at = u32(i, DATA + 8);
    expect(at).toBe(0x300);
    expect(u32(i, DATA + 0x18)).toBe(at);
    expect(i.readCString(at)).toBe('hello wonderful world');
    expect(u32(i, DATA + 12)).toBe(21);
    expect(i.readCString(STR)).toBe('hello world'); // the old string stays for other users
    // tampering: a pointer moved back, or the length changed
    const d = getEntry(zip, LIB)!.data.slice();
    new DataView(d.buffer).setUint32(DATA + 12, 1, true);
    setEntry(zip, { name: LIB, data: d });
    expect(p.detect(c)).toBe('incompatible');
  });
  it('relocates into an appended segment when there is no padding', () => {
    const { zip } = apply(edit('hello wonderful world'), { junkAt: 0x304 });
    const at = u32(img(zip), DATA + 8);
    expect(at).toBeGreaterThanOrEqual(0x1300);
    expect(img(zip).readCString(at)).toBe('hello wonderful world');
  });
  it('is incompatible when a pointer has no relative relocation or the original differs', () => {
    const lib = buildElf({ dynamic: 'none' });
    expect(makeNativePatch(spec(lib, [edit('hello wonderful world')])).detect(ctxFor(zipWith(lib)))).toBe('incompatible');
    const lib2 = buildElf();
    expect(makeNativePatch(spec(lib2, [edit('hello wonderful world', { original: 'jello world' })])).detect(ctxFor(zipWith(lib2)))).toBe('incompatible');
    expect(makeNativePatch(spec(lib2, [edit('hi', { pointers: [{ vaddr: DATA + 8, lengthVaddr: DATA + 0x2c }] })])).detect(ctxFor(zipWith(lib2)))).toBe('incompatible');
    expect(makeNativePatch(spec(lib2, [edit('hello wonderful world', { pointers: [{ vaddr: DATA + 0x28 }] })])).detect(ctxFor(zipWith(lib2)))).toBe('incompatible');
    expect(makeNativePatch(spec(lib2, [edit('hello wonderful world', { pointers: [{ vaddr: 0x9000 }] })])).detect(ctxFor(zipWith(lib2)))).toBe('incompatible');
  });
});
