import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { findElfSymbol, parseElfSections } from '../src/elf';
import { ElfImage, findObjcMethod } from '../src/native';
import { readZip, getEntry } from '../src/zip';
import { buildElf } from './elf-fixture';
import { haveApk } from './helpers';
import { OBJC, SYM, buildSymElf } from './sym-elf-fixture';

const set32 = (b: Uint8Array, at: number, v: number): void => new DataView(b.buffer, b.byteOffset).setUint32(at, v >>> 0, true);

describe('ELF sections and symbols', () => {
  it('reads section headers and names', () => {
    const s = parseElfSections(buildSymElf());
    expect(s.map((x) => x.name)).toEqual(['', '.text', '.dynsym', '.dynstr', '.symtab', '.strtab', '__DATA, __objc_classlist', '.shstrtab', '']);
    expect(s[2]).toMatchObject({ type: 11, link: 3, entsize: 16 });
  });

  it('rejects what it cannot read and tolerates files without sections', () => {
    expect(() => parseElfSections(new Uint8Array(60))).toThrow(/not an ELF/);
    const b64 = buildSymElf(); b64[4] = 2;
    expect(() => parseElfSections(b64)).toThrow(/32-bit little-endian/);
    const be = buildSymElf(); be[5] = 2;
    expect(() => parseElfSections(be)).toThrow(/32-bit little-endian/);
    expect(parseElfSections(buildElf())).toEqual([]);
    const noNum = buildSymElf(); noNum[48] = 0; noNum[49] = 0;
    expect(parseElfSections(noNum)).toEqual([]);
    const trunc = buildSymElf(); set32(trunc, 32, trunc.length - 10);
    expect(() => parseElfSections(trunc)).toThrow(/truncated/);
    const smallEnt = buildSymElf(); smallEnt[46] = 20;
    expect(() => parseElfSections(smallEnt)).toThrow(/truncated/);
    const badStr = buildSymElf(); badStr[50] = 30;
    expect(() => parseElfSections(badStr)).toThrow(/truncated/);
    const oob = buildSymElf();
    const shoff = new DataView(oob.buffer).getUint32(32, true);
    set32(oob, shoff + 40 + 20, 0x100000); // .text size beyond the file
    expect(() => parseElfSections(oob)).toThrow(/out of bounds/);
    // a section name running to the end of the file without a terminator
    const src = buildSymElf(), tail = new Uint8Array(src.length + 2);
    tail.set(src); tail.set([0x41, 0x42], src.length);
    const so = new DataView(tail.buffer).getUint32(32, true);
    set32(tail, so + 7 * 40 + 16, src.length); set32(tail, so + 7 * 40 + 20, 2);
    set32(tail, so + 40, 0);
    expect(parseElfSections(tail)[1]!.name).toBe('AB');
  });

  it('finds defined symbols in .dynsym, then .symtab', () => {
    const b = buildSymElf(), s = parseElfSections(b);
    expect(findElfSymbol(b, s, 'my_func')).toBe(SYM.func); // Thumb bit dropped
    expect(findElfSymbol(b, s, 'my_data')).toBe(SYM.data | 1); // data keeps its value
    expect(findElfSymbol(b, s, 'local_fn')).toBe(SYM.local);
    expect(findElfSymbol(b, s, 'imported')).toBeUndefined();
    expect(findElfSymbol(b, s, 'nope')).toBeUndefined();
    const z = buildSymElf({ zeroEntsize: true });
    expect(findElfSymbol(z, parseElfSections(z), 'my_func')).toBe(SYM.func);
    const bad = buildSymElf({ badLink: true });
    expect(findElfSymbol(bad, parseElfSections(bad), 'my_func')).toBeUndefined();
    expect(findElfSymbol(bad, parseElfSections(bad), 'local_fn')).toBe(SYM.local);
  });
});

describe('Objective-C method lookup', () => {
  const find = (b: Uint8Array, spec: string) => findObjcMethod(new ElfImage(b, false), parseElfSections(b), spec);

  it('finds instance and class methods', () => {
    const b = buildSymElf();
    expect(find(b, '-[Foo bar:]')).toBe(OBJC.imp);
    expect(find(b, '+[Foo make]')).toBe(OBJC.metaImp);
    expect(find(b, '-[Foo make]')).toBeUndefined();
    expect(find(b, '-[Bar bar:]')).toBeUndefined();
    expect(find(b, 'Foo bar:')).toBeUndefined();
    expect(find(buildSymElf({ noClasslist: true }), '-[Foo bar:]')).toBeUndefined();
  });

  it('gives up on unreadable metadata', () => {
    const mut = (f: (b: Uint8Array) => void): Uint8Array => { const b = buildSymElf(); f(b); return b; };
    expect(find(mut((b) => set32(b, OBJC.cls + 16, 0x90000)), '-[Foo bar:]')).toBeUndefined(); // ro unreadable
    expect(find(mut((b) => set32(b, OBJC.classlist + 4, 0x90000)), '-[Foo bar:]')).toBeUndefined(); // class unreadable
    expect(find(mut((b) => set32(b, OBJC.cls, 0x90000)), '+[Foo make]')).toBeUndefined(); // metaclass unreadable
    expect(find(mut((b) => set32(b, OBJC.meta + 16, 0x90000)), '+[Foo make]')).toBeUndefined(); // meta ro unreadable
    expect(find(mut((b) => set32(b, OBJC.ro + 20, 0)), '-[Foo bar:]')).toBeUndefined(); // no methods
    expect(find(mut((b) => set32(b, OBJC.methods, 4)), '-[Foo bar:]')).toBeUndefined(); // entsize too small
    expect(find(mut((b) => set32(b, OBJC.ro + 20, 0x11fc)), '-[Foo bar:]')).toBeUndefined(); // count beyond the segment
    expect(find(mut((b) => set32(b, OBJC.methods + 4, 100)), '-[Foo zzz]')).toBeUndefined(); // entries run off the segment
    const shoff = (b: Uint8Array): number => new DataView(b.buffer).getUint32(32, true);
    expect(find(mut((b) => set32(b, shoff(b) + 6 * 40 + 12, 0x90000)), '-[Foo bar:]')).toBeUndefined(); // class list not backed
    const impOff = mut((b) => { set32(b, OBJC.ro + 20, 0x11f0); set32(b, 0x11f0, 12); set32(b, 0x11f4, 1); set32(b, 0x11f8, OBJC.sel); });
    expect(find(impOff, '-[Foo bar:]')).toBeUndefined(); // imp beyond the segment
  });

  it.skipIf(!haveApk('/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk'))('finds a method of the real game library', () => {
    const zip = readZip(new Uint8Array(readFileSync('/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk')));
    const lib = getEntry(zip, 'lib/armeabi-v7a/libApplication.so')!.data;
    const imp = find(lib, '-[EvolutionAppDelegate application:didFinishLaunchingWithOptions:]');
    expect(imp).toBeTypeOf('number');
    expect(findElfSymbol(lib, parseElfSections(lib), 'JNI_OnLoad')).toBeTypeOf('number');
  });
});
