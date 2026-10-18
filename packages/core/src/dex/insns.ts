import { DexError } from './bytes';
import { FORMAT_UNITS, opInfo, refKind, type Format, type RefKind } from './opcodes';

export interface Insn {
  /** Offset in 16-bit code units. */
  at: number;
  /** Size in code units. */
  size: number;
  /** Opcode; -1 for data payloads (packed-switch, sparse-switch, fill-array-data). */
  op: number;
  name: string;
  format?: Format;
  /** Decoded operands in the same order the assembler takes them. */
  operands: number[];
  /** 64-bit literal of const-wide (51l). */
  wide?: bigint;
  /** Index operand (constant-pool kind and unit position of the index). */
  ref?: { kind: RefKind; index: number };
}

function payloadSize(u: Uint16Array, at: number): number {
  const ident = u[at]! >> 8;
  if (at + (ident === 3 ? 3 : 1) >= u.length) throw new DexError('truncated payload');
  if (ident === 1) return u[at + 1]! * 2 + 4;
  if (ident === 2) return u[at + 1]! * 4 + 2;
  return Math.floor((u[at + 1]! * ((u[at + 2]! | (u[at + 3]! << 16)) >>> 0) + 1) / 2) + 4;
}

const s8 = (v: number): number => (v << 24) >> 24;
const s16 = (v: number): number => (v << 16) >> 16;

/** Decodes the instruction at `at`. Throws on unknown opcodes or truncated code. */
export function decodeInsn(u: Uint16Array, at: number): Insn {
  const w = u[at]!;
  const op = w & 0xff;
  const hi = w >> 8;
  if (op === 0 && (hi === 1 || hi === 2 || hi === 3)) {
    const size = payloadSize(u, at);
    if (at + size > u.length) throw new DexError('payload past end of code');
    return { at, size, op: -1, name: ['packed-switch-payload', 'sparse-switch-payload', 'fill-array-data-payload'][hi - 1]!, operands: [] };
  }
  const info = opInfo(op);
  if (!info) throw new DexError(`unknown opcode 0x${op.toString(16)} at ${at}`);
  const size = FORMAT_UNITS[info.format];
  if (at + size > u.length) throw new DexError(`truncated instruction at ${at}`);
  const x = (i: number): number => u[at + i]!;
  const x32 = (i: number): number => (x(i) | (x(i + 1) << 16)) | 0;
  let operands: number[];
  let wide: bigint | undefined;
  switch (info.format) {
    case '10x': operands = []; break;
    case '12x': operands = [(w >> 8) & 0xf, w >> 12]; break;
    case '11n': operands = [(w >> 8) & 0xf, (w >> 12 << 28) >> 28]; break;
    case '11x': operands = [hi]; break;
    case '10t': operands = [s8(hi)]; break;
    case '20t': operands = [s16(x(1))]; break;
    case '22x': operands = [hi, x(1)]; break;
    case '21t': case '21s': case '21h': operands = [hi, s16(x(1))]; break;
    case '21c': operands = [hi, x(1)]; break;
    case '23x': operands = [hi, x(1) & 0xff, x(1) >> 8]; break;
    case '22b': operands = [hi, x(1) & 0xff, s8(x(1) >> 8)]; break;
    case '22t': case '22s': operands = [(w >> 8) & 0xf, w >> 12, s16(x(1))]; break;
    case '22c': operands = [(w >> 8) & 0xf, w >> 12, x(1)]; break;
    case '32x': operands = [x(1), x(2)]; break;
    case '30t': operands = [x32(1)]; break;
    case '31i': case '31t': operands = [hi, x32(1)]; break;
    case '31c': operands = [hi, x32(1) >>> 0]; break;
    case '35c': operands = [x(1), ...regList(w >> 12, x(2), w)]; break;
    case '3rc': operands = [x(1), x(2), hi]; break;
    case '45cc': operands = [x(1), x(3), ...regList(w >> 12, x(2), w)]; break;
    case '4rcc': operands = [x(1), x(3), x(2), hi]; break;
    case '51l': operands = [hi]; wide = BigInt.asIntN(64, BigInt(x(1)) | (BigInt(x(2)) << 16n) | (BigInt(x(3)) << 32n) | (BigInt(x(4)) << 48n)); break;
  }
  const kind = refKind(op);
  const insn: Insn = { at, size, op, name: info.name, format: info.format, operands };
  if (wide !== undefined) insn.wide = wide;
  if (kind) insn.ref = { kind, index: operands[info.format === '31c' || info.format === '21c' ? 1 : info.format === '22c' ? 2 : 0]! };
  return insn;
}

function regList(count: number, fedc: number, w: number): number[] {
  const regs = [fedc & 0xf, (fedc >> 4) & 0xf, (fedc >> 8) & 0xf, fedc >> 12, (w >> 8) & 0xf];
  return regs.slice(0, count);
}

/** Decodes all instructions of a method body. */
export function decodeAll(u: Uint16Array): Insn[] {
  const out: Insn[] = [];
  for (let at = 0; at < u.length; ) {
    const i = decodeInsn(u, at);
    out.push(i);
    at += i.size;
  }
  return out;
}

export interface IndexMaps {
  string(i: number): number;
  type(i: number): number;
  field(i: number): number;
  method(i: number): number;
  proto(i: number): number;
}

/** Returns a copy of `u` with every constant-pool index mapped. Throws when a mapped index no longer fits its operand. */
export function remapInsns(u: Uint16Array, maps: IndexMaps): Uint16Array {
  const out = u.slice();
  for (let at = 0; at < u.length; ) {
    const i = decodeInsn(u, at);
    if (i.ref) {
      const nv = maps[i.ref.kind](i.ref.index);
      if (i.format === '31c') {
        out[at + 1] = nv & 0xffff;
        out[at + 2] = nv >>> 16;
      } else {
        if (nv > 0xffff) throw new DexError(`${i.ref.kind} index ${nv} no longer fits instruction ${i.name} at ${at}`);
        out[at + 1] = nv;
      }
      if (i.op === 0xfa || i.op === 0xfb) out[at + 3] = maps.proto(u[at + 3]!);
    } else if (i.op === 0xff) {
      out[at + 1] = maps.proto(u[at + 1]!);
    }
    at += i.size;
  }
  return out;
}
