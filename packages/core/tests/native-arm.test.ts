import { describe, it, expect } from 'vitest';
import {
  EncodeError, decodeArmBranch, decodeThumbBranch, encodeArmB, encodeArmBlxImm, encodeArmBlxReg, encodeArmBx, encodeArmLdrLiteral,
  encodeThumbBNarrow, encodeThumbBl, encodeThumbBlx, encodeThumbBlxReg, encodeThumbBw, encodeThumbBx, encodeThumbLdrLiteral,
  halfwordsToBytes, wordsToBytes,
} from '../src/native';

const hex = (n: number): string => n.toString(16);

describe('byte helpers', () => {
  it('serialises little endian', () => {
    expect(wordsToBytes([0x11223344])).toEqual([0x44, 0x33, 0x22, 0x11]);
    expect(halfwordsToBytes([0x1122, 0xbf00])).toEqual([0x22, 0x11, 0x00, 0xbf]);
  });
});

// Expected values were produced with llvm-mc (armv7a / thumbv7a) for the same relative offsets.
describe('ARM encoders', () => {
  it('encodes B, BL and conditional branches', () => {
    expect(hex(encodeArmB(0x1000, 0x2000))).toBe('ea0003fe');
    expect(hex(encodeArmB(0x2000, 0x1000, true))).toBe('ebfffbfe');
    expect(hex(encodeArmB(0x1000, 0x2000, false, 1))).toBe('1a0003fe');
  });
  it('encodes BLX immediate with the H bit', () => {
    expect(hex(encodeArmBlxImm(0x1000, 0x2002))).toBe('fb0003fe');
    expect(hex(encodeArmBlxImm(0x2000, 0x1000))).toBe('fafffbfe');
  });
  it('encodes register branches and literal loads', () => {
    expect(hex(encodeArmBx(12))).toBe('e12fff1c');
    expect(hex(encodeArmBlxReg(3))).toBe('e12fff33');
    expect(hex(encodeArmBx(1, 0))).toBe('12fff11');
    expect(hex(encodeArmBlxReg(1, 0))).toBe('12fff31');
    expect(hex(encodeArmLdrLiteral(0, 0x1000, 0x1010))).toBe('e59f0008');
    expect(hex(encodeArmLdrLiteral(3, 0x1010, 0x1000))).toBe('e51f3018');
    expect(hex(encodeArmLdrLiteral(3, 0x1010, 0x1000, 1))).toBe('151f3018');
  });
  it('rejects misaligned or too distant operands', () => {
    expect(() => encodeArmB(0x1002, 0x2000)).toThrow(EncodeError);
    expect(() => encodeArmB(0x1000, 0x2002)).toThrow('not 4-byte aligned');
    expect(() => encodeArmB(0, 0x4000000)).toThrow('out of range');
    expect(() => encodeArmBlxImm(0x1000, 0x2001)).toThrow('not 2-byte aligned');
    expect(() => encodeArmBlxImm(0x1002, 0x2000)).toThrow(EncodeError);
    expect(() => encodeArmBlxImm(0, 0x4000000)).toThrow('out of range');
    expect(() => encodeArmLdrLiteral(0, 0x1000, 0x3000)).toThrow('out of range');
    expect(() => encodeArmLdrLiteral(0, 0x3000, 0x1000)).toThrow('out of range');
  });
});

describe('Thumb encoders', () => {
  it('encodes BL, BLX and B.W', () => {
    expect(encodeThumbBl(0, 0x1004).map(hex)).toEqual(['f001', 'f800']);
    expect(encodeThumbBl(0x1006, 0).map(hex)).toEqual(['f7fe', 'fffb']);
    expect(encodeThumbBw(0x100a, 0).map(hex)).toEqual(['f7fe', 'bff9']);
    expect(encodeThumbBw(4, 0x1004).map(hex)).toEqual(['f000', 'bffe']);
    expect(encodeThumbBlx(0x1000, 0x2000).map(hex)).toEqual(['f000', 'effe']);
    expect(encodeThumbBlx(0x1002, 0x2000).map(hex)).toEqual(['f000', 'effe']);
  });
  it('encodes the narrow branch and register branches', () => {
    expect(hex(encodeThumbBNarrow(0, 0xf2))).toBe('e077');
    expect(hex(encodeThumbBNarrow(0xf4, 0))).toBe('e784');
    expect(hex(encodeThumbBx(14))).toBe('4770');
    expect(hex(encodeThumbBlxReg(3))).toBe('4798');
  });
  it('encodes literal loads in both forms', () => {
    expect(encodeThumbLdrLiteral(2, 0x10c, 0x11c).map(hex)).toEqual(['4a03']);
    expect(encodeThumbLdrLiteral(9, 0x10e, 0x11c).map(hex)).toEqual(['f8df', '900c']);
    expect(encodeThumbLdrLiteral(2, 0x1010, 0x1000).map(hex)).toEqual(['f85f', '2014']);
    expect(encodeThumbLdrLiteral(2, 0x1000, 0x2000)).toHaveLength(2); // too far for T1
  });
  it('rejects bad operands', () => {
    expect(() => encodeThumbBl(1, 0x1000)).toThrow('not 2-byte aligned');
    expect(() => encodeThumbBl(0, 0x2000000)).toThrow('out of range');
    expect(() => encodeThumbBlx(0, 0x1002)).toThrow('not 4-byte aligned');
    expect(() => encodeThumbBNarrow(1, 0)).toThrow(EncodeError);
    expect(() => encodeThumbBNarrow(0, 3)).toThrow(EncodeError);
    expect(() => encodeThumbBNarrow(0, 0x1000)).toThrow('out of range');
    expect(() => encodeThumbLdrLiteral(2, 1, 4)).toThrow(EncodeError);
    expect(() => encodeThumbLdrLiteral(2, 0, 6)).toThrow('not 4-byte aligned');
    expect(() => encodeThumbLdrLiteral(2, 0x4000, 0x1000)).toThrow('out of range');
  });
});

describe('decoders', () => {
  it('round-trips ARM branches', () => {
    expect(decodeArmBranch(encodeArmB(0x1000, 0x2000), 0x1000)).toEqual({ target: 0x2000, mode: 'arm', link: false });
    expect(decodeArmBranch(encodeArmB(0x2000, 0x1000, true), 0x2000)).toEqual({ target: 0x1000, mode: 'arm', link: true });
    expect(decodeArmBranch(encodeArmBlxImm(0x1000, 0x2002), 0x1000)).toEqual({ target: 0x2002, mode: 'thumb', link: true });
    expect(decodeArmBranch(encodeArmBlxImm(0x1000, 0x2000), 0x1000)).toEqual({ target: 0x2000, mode: 'thumb', link: true });
    expect(decodeArmBranch(0xe1a00000, 0)).toBeUndefined();
  });
  it('round-trips Thumb branches', () => {
    const d = (hw: number[], at: number) => decodeThumbBranch(hw[0]!, hw[1]!, at);
    expect(d(encodeThumbBl(0x1000, 0x2000), 0x1000)).toEqual({ target: 0x2000, mode: 'thumb', link: true, size: 4 });
    expect(d(encodeThumbBl(0x2000, 0x1000), 0x2000)).toEqual({ target: 0x1000, mode: 'thumb', link: true, size: 4 });
    expect(d(encodeThumbBw(0x1000, 0xc00000), 0x1000)).toEqual({ target: 0xc00000, mode: 'thumb', link: false, size: 4 });
    expect(d(encodeThumbBw(0xc00000, 0x1000), 0xc00000)).toEqual({ target: 0x1000, mode: 'thumb', link: false, size: 4 });
    expect(d(encodeThumbBlx(0x1002, 0x2000), 0x1002)).toEqual({ target: 0x2000, mode: 'arm', link: true, size: 4 });
    expect(decodeThumbBranch(encodeThumbBNarrow(0x100, 0x180), 0, 0x100)).toEqual({ target: 0x180, mode: 'thumb', link: false, size: 2 });
    expect(decodeThumbBranch(encodeThumbBNarrow(0x100, 0x20), 0, 0x100)).toEqual({ target: 0x20, mode: 'thumb', link: false, size: 2 });
    expect(decodeThumbBranch(0x4770, 0, 0)).toBeUndefined();
    expect(decodeThumbBranch(0xf000, 0x0000, 0)).toBeUndefined();
  });
});
