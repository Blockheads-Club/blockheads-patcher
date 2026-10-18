import { DexError } from './bytes';
import { FORMAT_UNITS, opByName, type Format } from './opcodes';

/** A register, literal or constant-pool index; a string refers to a label (branch formats only). */
export type Operand = number | string | bigint;

export interface CatchHandler { type: number; label: string }
export interface TryBlock { start: string; end: string; handlers?: CatchHandler[]; catchAll?: string }

export interface CodeHandler { catches: { type: number; addr: number }[]; catchAll?: number }
export interface CodeTry { start: number; count: number; handler: number }
/** The assembled body of a method (indices are provisional constant-pool indices of the owning DexFile). */
export interface CodeData {
  registers: number;
  ins: number;
  outs: number;
  insns: Uint16Array;
  tries: CodeTry[];
  handlers: CodeHandler[];
}

type Entry = { at: number; format: Format; op: number; name: string; operands: Operand[] } | { at: number; raw: number[] };

function fit(v: Operand, bits: number, signed: boolean, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new DexError(`${what}: expected an integer, got ${String(v)}`);
  const lo = signed ? -(2 ** (bits - 1)) : 0;
  const hi = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  if (v < lo || v > hi) throw new DexError(`${what}: ${v} does not fit ${bits} bits`);
  return v;
}

/**
 * Small Dalvik assembler: emits instructions by mnemonic with operand lists in the order of the official format
 * documentation (registers, then literal/index/offset). Branch offsets may be label names.
 */
export class CodeBuilder {
  private entries: Entry[] = [];
  private labels = new Map<string, number>();
  private tryBlocks: TryBlock[] = [];
  private units = 0;
  private maxReg = -1;
  constructor(private readonly opts: { registers: number; outs?: number }) {}

  /** Defines a label at the current position. */
  label(name: string): this {
    if (this.labels.has(name)) throw new DexError(`duplicate label ${name}`);
    this.labels.set(name, this.units);
    return this;
  }

  /** Appends one instruction. */
  op(name: string, ...operands: Operand[]): this {
    const info = opByName(name);
    this.entries.push({ at: this.units, format: info.format, op: info.op, name, operands });
    this.units += FORMAT_UNITS[info.format];
    return this;
  }

  /** Appends raw code units (data payloads). */
  raw(...units: number[]): this {
    this.entries.push({ at: this.units, raw: units });
    this.units += units.length;
    return this;
  }

  /** Declares a try range [start, end) with typed handlers and/or a catch-all; labels are resolved by build(). */
  tryCatch(block: TryBlock): this {
    this.tryBlocks.push(block);
    return this;
  }

  private reg(v: Operand, bits: number, what: string): number {
    const r = fit(v, bits, false, `${what} register`);
    if (r > this.maxReg) this.maxReg = r;
    return r;
  }

  private target(v: Operand, at: number, bits: number): number {
    if (typeof v !== 'string') return fit(v, bits, true, 'branch offset');
    const t = this.labels.get(v);
    if (t === undefined) throw new DexError(`undefined label ${v}`);
    return fit(t - at, bits, true, `branch to ${v}`);
  }

  private encode(e: Extract<Entry, { format: Format }>): number[] {
    const { op, name, operands: o } = e;
    const nm = (n: number): void => { if (o.length !== n) throw new DexError(`${name} takes ${n} operands, got ${o.length}`); };
    const r = (i: number, bits: number): number => this.reg(o[i]!, bits, name);
    const off = (i: number, bits: number): number => this.target(o[i]!, e.at, bits);
    const lit = (i: number, bits: number): number => fit(o[i]!, bits, true, `${name} literal`);
    const u16 = (i: number, what: string): number => fit(o[i]!, 16, false, `${name} ${what}`);
    switch (e.format) {
      case '10x': nm(0); return [op];
      case '12x': nm(2); return [op | (r(0, 4) << 8) | (r(1, 4) << 12)];
      case '11n': nm(2); return [op | (r(0, 4) << 8) | ((lit(1, 4) & 0xf) << 12)];
      case '11x': nm(1); return [op | (r(0, 8) << 8)];
      case '10t': nm(1); return [op | ((off(0, 8) & 0xff) << 8)];
      case '20t': nm(1); return [op, off(0, 16) & 0xffff];
      case '22x': nm(2); return [op | (r(0, 8) << 8), r(1, 16)];
      case '21t': nm(2); return [op | (r(0, 8) << 8), off(1, 16) & 0xffff];
      case '21s': case '21h': nm(2); return [op | (r(0, 8) << 8), lit(1, 16) & 0xffff];
      case '21c': nm(2); return [op | (r(0, 8) << 8), u16(1, 'index')];
      case '23x': nm(3); return [op | (r(0, 8) << 8), r(1, 8) | (r(2, 8) << 8)];
      case '22b': nm(3); return [op | (r(0, 8) << 8), r(1, 8) | ((lit(2, 8) & 0xff) << 8)];
      case '22t': nm(3); return [op | (r(0, 4) << 8) | (r(1, 4) << 12), off(2, 16) & 0xffff];
      case '22s': nm(3); return [op | (r(0, 4) << 8) | (r(1, 4) << 12), lit(2, 16) & 0xffff];
      case '22c': nm(3); return [op | (r(0, 4) << 8) | (r(1, 4) << 12), u16(2, 'index')];
      case '32x': nm(2); return [op, r(0, 16), r(1, 16)];
      case '30t': { nm(1); const v = off(0, 32); return [op, v & 0xffff, (v >> 16) & 0xffff]; }
      case '31t': { nm(2); const a = r(0, 8), v = off(1, 32); return [op | (a << 8), v & 0xffff, (v >> 16) & 0xffff]; }
      case '31i': { nm(2); const a = r(0, 8), v = lit(1, 32); return [op | (a << 8), v & 0xffff, (v >> 16) & 0xffff]; }
      case '31c': { nm(2); const a = r(0, 8), v = fit(o[1]!, 32, false, `${name} index`); return [op | (a << 8), v & 0xffff, v >>> 16]; }
      case '35c': {
        if (o.length < 1 || o.length > 6) throw new DexError(`${name} takes an index and up to 5 registers`);
        return [...this.fiveRegs(op, u16(0, 'index'), o.slice(1), name)];
      }
      case '45cc': {
        if (o.length < 2 || o.length > 7) throw new DexError(`${name} takes method, proto and up to 5 registers`);
        const [a, b, c] = this.fiveRegs(op, u16(0, 'method'), o.slice(2), name);
        return [a, b, c, u16(1, 'proto')];
      }
      case '3rc': { nm(3); return [op | (fit(o[2]!, 8, false, `${name} count`) << 8), u16(0, 'index'), this.rangeStart(o[1]!, o[2] as number, name)]; }
      case '4rcc': { nm(4); return [op | (fit(o[3]!, 8, false, `${name} count`) << 8), u16(0, 'method'), this.rangeStart(o[2]!, o[3] as number, name), u16(1, 'proto')]; }
      case '51l': {
        nm(2);
        const a = r(0, 8);
        const v = o[1];
        if (typeof v !== 'bigint' && typeof v !== 'number') throw new DexError(`${name} literal must be a number or bigint`);
        const w = BigInt.asUintN(64, BigInt(v));
        return [op | (a << 8), Number(w & 0xffffn), Number((w >> 16n) & 0xffffn), Number((w >> 32n) & 0xffffn), Number((w >> 48n) & 0xffffn)];
      }
    }
  }

  private fiveRegs(op: number, idx: number, regs: Operand[], name: string): [number, number, number] {
    const g = regs.map((v) => this.reg(v, 4, name));
    const pad = (i: number): number => g[i] ?? 0;
    return [op | (g.length << 12) | (pad(4) << 8), idx, pad(0) | (pad(1) << 4) | (pad(2) << 8) | (pad(3) << 12)];
  }

  private rangeStart(first: Operand, count: number, name: string): number {
    const f = this.reg(first, 16, name);
    this.reg(f + Math.max(count, 1) - 1, 16, name);
    return f;
  }

  /** Assembles the body. `ins` is the number of incoming argument registers (derived from the method signature). */
  build(ins: number): CodeData {
    const insns: number[] = [];
    for (const e of this.entries) {
      if ('raw' in e) insns.push(...e.raw);
      else insns.push(...this.encode(e));
    }
    const label = (n: string): number => {
      const v = this.labels.get(n);
      if (v === undefined) throw new DexError(`undefined label ${n}`);
      return v;
    };
    const tries: CodeTry[] = [];
    const handlers: CodeHandler[] = [];
    for (const t of this.tryBlocks) {
      const start = label(t.start), end = label(t.end);
      if (end <= start) throw new DexError('empty try range');
      const h: CodeHandler = { catches: (t.handlers ?? []).map((c) => ({ type: c.type, addr: label(c.label) })) };
      if (t.catchAll !== undefined) h.catchAll = label(t.catchAll);
      if (!h.catches.length && h.catchAll === undefined) throw new DexError('try block without handlers');
      tries.push({ start, count: fit(end - start, 16, false, 'try range'), handler: handlers.length });
      handlers.push(h);
    }
    tries.sort((a, b) => a.start - b.start);
    const registers = this.opts.registers;
    if (this.maxReg >= registers) throw new DexError(`register v${this.maxReg} used but only ${registers} registers declared`);
    if (ins > registers) throw new DexError(`${ins} argument registers do not fit in ${registers} registers`);
    return { registers, ins, outs: this.opts.outs ?? 0, insns: Uint16Array.from(insns), tries, handlers };
  }
}
