/** ARM / Thumb-2 branch encoders and decoders for native patching (little-endian only). */

export type CodeMode = 'arm' | 'thumb';
export const ARM_NOP = 0xe1a00000; // mov r0, r0 (valid on every ARM core)
export const THUMB_NOP = 0xbf00;
export const COND_AL = 0xe;

export class EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodeError';
  }
}

/** Raw bytes of a list of 32-bit little-endian words. */
export function wordsToBytes(words: readonly number[]): number[] {
  const out: number[] = [];
  for (const w of words) out.push(w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff);
  return out;
}
/** Raw bytes of a list of 16-bit little-endian halfwords. */
export function halfwordsToBytes(halves: readonly number[]): number[] {
  const out: number[] = [];
  for (const h of halves) out.push(h & 0xff, (h >>> 8) & 0xff);
  return out;
}

function checkRange(offset: number, bits: number, what: string): void {
  const lim = 2 ** (bits - 1);
  if (offset < -lim || offset >= lim) throw new EncodeError(`${what}: branch offset ${offset} is out of range (+-${lim})`);
}
function checkImm12(offset: number, what: string): void {
  if (Math.abs(offset) > 4095) throw new EncodeError(`${what}: literal offset ${offset} is out of range (+-4095)`);
}
function checkAlign(addr: number, align: number, what: string): void {
  if (addr % align !== 0) throw new EncodeError(`${what}: address 0x${addr.toString(16)} is not ${align}-byte aligned`);
}

/** ARM B/BL to an ARM target. `cond` is the 4-bit condition (0xe = always). */
export function encodeArmB(from: number, to: number, link = false, cond = COND_AL): number {
  checkAlign(from, 4, 'ARM branch site');
  checkAlign(to, 4, 'ARM branch target');
  const off = to - (from + 8);
  checkRange(off, 26, 'ARM branch');
  return (((cond << 28) | (0b101 << 25) | ((link ? 1 : 0) << 24) | ((off >> 2) & 0xffffff)) >>> 0);
}
/** ARM BLX (immediate) to a Thumb target; always sets lr. Unconditional only. */
export function encodeArmBlxImm(from: number, to: number): number {
  checkAlign(from, 4, 'ARM BLX site');
  checkAlign(to, 2, 'Thumb branch target');
  const off = to - (from + 8);
  checkRange(off, 26, 'ARM BLX');
  return (0xfa000000 | (((off >> 1) & 1) << 24) | ((off >> 2) & 0xffffff)) >>> 0;
}
/** ARM BX Rm. */
export const encodeArmBx = (rm: number, cond = COND_AL): number => ((cond << 28) | 0x012fff10 | rm) >>> 0;
/** ARM BLX Rm. */
export const encodeArmBlxReg = (rm: number, cond = COND_AL): number => ((cond << 28) | 0x012fff30 | rm) >>> 0;
/** ARM `ldr rt, [pc, #off]` where `off` is relative to pc (= instruction address + 8). */
export function encodeArmLdrLiteral(rt: number, from: number, literal: number, cond = COND_AL): number {
  const off = literal - (from + 8);
  checkImm12(off, 'ARM literal load');
  const up = off >= 0 ? 1 : 0;
  return ((cond << 28) | 0x051f0000 | (up << 23) | (rt << 12) | Math.abs(off)) >>> 0;
}

function thumb32(to: number, base: number, hw2Bits: number, what: string, align: number): [number, number] {
  const off = to - base;
  checkRange(off, 25, what);
  checkAlign(to, align, what + ' target');
  const s = (off >> 24) & 1;
  const i1 = (off >> 23) & 1;
  const i2 = (off >> 22) & 1;
  const j1 = (~(i1 ^ s)) & 1;
  const j2 = (~(i2 ^ s)) & 1;
  const imm10 = (off >> 12) & 0x3ff;
  const imm11 = (off >> 1) & 0x7ff;
  return [0xf000 | (s << 10) | imm10, hw2Bits | (j1 << 13) | (j2 << 11) | imm11];
}
/** Thumb-2 BL to a Thumb target (sets lr with the Thumb bit). */
export function encodeThumbBl(from: number, to: number): [number, number] {
  checkAlign(from, 2, 'Thumb branch site');
  return thumb32(to, from + 4, 0xd000, 'Thumb BL', 2);
}
/** Thumb-2 BLX (immediate) to an ARM target; sets lr. */
export function encodeThumbBlx(from: number, to: number): [number, number] {
  checkAlign(from, 2, 'Thumb branch site');
  return thumb32(to, (from + 4) & ~3, 0xc000, 'Thumb BLX', 4);
}
/** Thumb-2 B.W (T4) to a Thumb target. */
export function encodeThumbBw(from: number, to: number): [number, number] {
  checkAlign(from, 2, 'Thumb branch site');
  return thumb32(to, from + 4, 0x9000, 'Thumb B.W', 2);
}
/** 16-bit Thumb B (T2), range +-2 KiB. */
export function encodeThumbBNarrow(from: number, to: number): number {
  checkAlign(from, 2, 'Thumb branch site');
  checkAlign(to, 2, 'Thumb branch target');
  const off = to - (from + 4);
  checkRange(off, 12, 'Thumb B');
  return 0xe000 | ((off >> 1) & 0x7ff);
}
/** Thumb BX Rm. */
export const encodeThumbBx = (rm: number): number => 0x4700 | (rm << 3);
/** Thumb BLX Rm. */
export const encodeThumbBlxReg = (rm: number): number => 0x4780 | (rm << 3);
/** Thumb `ldr rt, [pc, #off]`: T1 (16-bit, rt < 8, forward, word aligned) or T2 (32-bit). Returns halfwords. */
export function encodeThumbLdrLiteral(rt: number, from: number, literal: number): number[] {
  checkAlign(from, 2, 'Thumb literal load site');
  checkAlign(literal, 4, 'Thumb literal');
  const off = literal - ((from + 4) & ~3);
  if (rt < 8 && off >= 0 && off <= 1020) return [0x4800 | (rt << 8) | (off >> 2)];
  checkImm12(off, 'Thumb literal load');
  return [0xf85f | ((off >= 0 ? 1 : 0) << 7), (rt << 12) | Math.abs(off)];
}

export interface DecodedBranch {
  /** Target address; its mode is `mode`. */
  target: number;
  mode: CodeMode;
  link: boolean;
}

/** Decodes an ARM B/BL/BLX(imm) instruction at `at`, or undefined. */
export function decodeArmBranch(word: number, at: number): DecodedBranch | undefined {
  if (((word >>> 25) & 7) !== 0b101) return undefined;
  const cond = word >>> 28;
  let off = (word & 0xffffff) << 2;
  if (off & (1 << 25)) off -= 1 << 26;
  const base = at + 8 + off;
  if (cond === 0xf) return { target: base + (((word >>> 24) & 1) << 1), mode: 'thumb', link: true };
  return { target: base, mode: 'arm', link: ((word >>> 24) & 1) === 1 };
}

/** Decodes a Thumb-2 BL/BLX/B.W (two halfwords) or narrow B (`hw2` ignored) at `at`, or undefined. */
export function decodeThumbBranch(hw1: number, hw2: number, at: number): (DecodedBranch & { size: 2 | 4 }) | undefined {
  if ((hw1 & 0xf800) === 0xe000) {
    let off = (hw1 & 0x7ff) << 1;
    if (off & 0x800) off -= 0x1000;
    return { target: at + 4 + off, mode: 'thumb', link: false, size: 2 };
  }
  if ((hw1 & 0xf800) !== 0xf000) return undefined;
  const kind = hw2 & 0xd000;
  if (kind !== 0xd000 && kind !== 0xc000 && kind !== 0x9000) return undefined;
  const s = (hw1 >> 10) & 1;
  const i1 = (~((hw2 >> 13) ^ s)) & 1;
  const i2 = (~((hw2 >> 11) ^ s)) & 1;
  let off = (s << 24) | (i1 << 23) | (i2 << 22) | ((hw1 & 0x3ff) << 12) | ((hw2 & 0x7ff) << 1);
  if (s) off -= 1 << 25;
  if (kind === 0xc000) return { target: ((at + 4) & ~3) + off, mode: 'arm', link: true, size: 4 };
  return { target: at + 4 + off, mode: 'thumb', link: kind === 0xd000, size: 4 };
}
