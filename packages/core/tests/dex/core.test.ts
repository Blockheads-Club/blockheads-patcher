import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { ByteReader, ByteWriter, DexError } from '../../src/dex/bytes';
import { decodeMutf8, encodeMutf8, utf16Length } from '../../src/dex/mutf8';
import { adler32, sha1 } from '../../src/dex/hash';
import { CodeBuilder, decodeAll, decodeInsn, opByName, opInfo, remapInsns, type Format } from '../../src/dex';
import { FORMAT_UNITS, refKind } from '../../src/dex/opcodes';

describe('LEB128 and byte streams', () => {
  it('round-trips unsigned, signed and p1 values', () => {
    const w = new ByteWriter();
    const us = [0, 1, 127, 128, 300, 16383, 16384, 2 ** 28, 2 ** 32 - 1];
    const ss = [0, 1, -1, 63, 64, -64, -65, 8191, -8192, 2 ** 31 - 1, -(2 ** 31)];
    us.forEach((v) => w.uleb(v));
    ss.forEach((v) => w.sleb(v));
    w.ulebP1(-1); w.ulebP1(5);
    const r = new ByteReader(w.result());
    us.forEach((v) => expect(r.uleb()).toBe(v));
    ss.forEach((v) => expect(r.sleb()).toBe(v));
    expect(r.ulebP1()).toBe(-1);
    expect(r.ulebP1()).toBe(5);
  });
  it('grows, aligns, patches and reads fixed-width values', () => {
    const w = new ByteWriter();
    for (let i = 0; i < 3000; i++) w.u8(i);
    w.u16(0xabcd); w.u32(0xdeadbeef); w.align(8);
    expect(w.len % 8).toBe(0);
    w.set32(0, 0x01020304);
    const r = new ByteReader(w.result());
    expect(r.u32()).toBe(0x01020304);
    r.pos = 3000;
    expect(r.u16()).toBe(0xabcd);
    expect(r.u32()).toBe(0xdeadbeef);
    r.pos = 0;
    expect(Array.from(r.bytes(2))).toEqual([4, 3]);
    const big = new ByteWriter();
    big.bytes(new Uint8Array(5000));
    expect(big.len).toBe(5000);
  });
  it('rejects reads out of bounds and over-long LEB128', () => {
    expect(() => new ByteReader(new Uint8Array(2)).u32()).toThrow(DexError);
    expect(() => new ByteReader(new Uint8Array(2), 5).u8()).toThrow('out of bounds');
    expect(() => new ByteReader(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0)).uleb()).toThrow('too long');
    expect(() => new ByteReader(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0)).sleb()).toThrow('too long');
  });
});

describe('modified UTF-8', () => {
  it('round-trips ASCII, NUL, BMP and surrogate pairs', () => {
    for (const s of ['', 'abc', 'a\u0000b', 'héllo', '日本語', '\u{1F600}', 'x'.repeat(10000)]) {
      const e = encodeMutf8(s);
      expect(e.includes(0)).toBe(false);
      expect(decodeMutf8(e)).toBe(s);
      expect(utf16Length(e)).toBe(s.length);
    }
  });
  it('rejects malformed input', () => {
    expect(() => decodeMutf8(Uint8Array.of(0xc3))).toThrow(DexError);
    expect(() => decodeMutf8(Uint8Array.of(0xe3, 0x81))).toThrow(DexError);
    expect(() => decodeMutf8(Uint8Array.of(0xf0, 0x80, 0x80, 0x80))).toThrow('invalid modified UTF-8');
  });
});

describe('checksums', () => {
  it('adler32 matches known values', () => {
    expect(adler32(new TextEncoder().encode('Wikipedia'))).toBe(0x11e60398);
    expect(adler32(new Uint8Array(0))).toBe(1);
    const big = new Uint8Array(200000).map((_, i) => (i * 31) & 255);
    let a = 1, b = 0;
    for (const x of big) { a = (a + x) % 65521; b = (b + a) % 65521; }
    expect(adler32(big)).toBe(((b << 16) | a) >>> 0);
  });
  it('sha1 matches node:crypto for assorted lengths', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100000]) {
      const d = new Uint8Array(n).map((_, i) => (i * 7 + 3) & 255);
      expect(Buffer.from(sha1(d)).toString('hex')).toBe(createHash('sha1').update(d).digest('hex'));
    }
  });
});

const SAMPLE: Record<Format, (number | bigint)[]> = {
  '10x': [], '12x': [1, 2], '11n': [3, -2], '11x': [7], '10t': [-3], '20t': [300], '22x': [200, 4000], '21t': [5, -7], '21s': [9, -300],
  '21h': [2, -2], '21c': [4, 1234], '23x': [1, 2, 3], '22b': [1, 2, -5], '22t': [1, 2, -30], '22s': [3, 4, -1000], '22c': [5, 6, 999],
  '32x': [1000, 2000], '30t': [-100000], '31t': [4, 100000], '31i': [3, -123456], '31c': [2, 70000], '35c': [55, 1, 2, 3],
  '3rc': [55, 10, 4], '45cc': [55, 66, 1, 2], '4rcc': [55, 66, 10, 3], '51l': [3, -0x1234567890abcdefn],
};

describe('opcode table, assembler and decoder', () => {
  const ops = Array.from({ length: 256 }, (_, i) => opInfo(i)).filter((x) => x !== undefined);
  it('defines the documented opcodes', () => {
    expect(ops.length).toBe(224);
    expect(opInfo(0x73)).toBeUndefined();
    expect(opInfo(0xe3)).toBeUndefined();
  });
  it.each(ops.map((o) => [o.name, o] as const))('assembles and decodes %s', (_n, o) => {
    const operands = SAMPLE[o.format];
    const code = new CodeBuilder({ registers: 65535 }).op(o.name, ...operands).build(0);
    expect(code.insns.length).toBe(FORMAT_UNITS[o.format]);
    expect(code.insns[0]! & 0xff).toBe(o.op);
    const d = decodeInsn(code.insns, 0);
    expect(d.name).toBe(o.name);
    if (o.format === '51l') {
      expect(d.operands).toEqual([3]);
      expect(d.wide).toBe(-0x1234567890abcdefn);
    } else {
      expect(d.operands).toEqual(operands);
      expect(d.wide).toBeUndefined();
    }
    expect(d.ref?.kind).toBe(refKind(o.op));
    expect(opByName(o.name)).toBe(o);
  });
  it('decodes sequences with data payloads', () => {
    const b = new CodeBuilder({ registers: 2 }).op('packed-switch', 0, 'p').op('nop').label('p')
      .raw(0x0100, 2, 0, 0, 5, 0, 6, 0).raw(0x0200, 1, 3, 0, 4, 0).raw(0x0300, 2, 3, 0, 1, 2, 3).op('return-void');
    const insns = decodeAll(b.build(0).insns);
    expect(insns.map((i) => i.name)).toEqual(['packed-switch', 'nop', 'packed-switch-payload', 'sparse-switch-payload', 'fill-array-data-payload', 'return-void']);
    expect(insns[2]!.size).toBe(8);
    expect(insns[3]!.size).toBe(6);
    expect(insns[4]!.size).toBe(7);
  });
  it('rejects bad code', () => {
    expect(() => decodeInsn(Uint16Array.of(0x003e), 0)).toThrow('unknown opcode');
    expect(() => decodeInsn(Uint16Array.of(0x0014, 0), 0)).toThrow('truncated instruction');
    expect(() => decodeInsn(Uint16Array.of(0x0100), 0)).toThrow('truncated payload');
    expect(() => decodeInsn(Uint16Array.of(0x0300, 1, 1), 0)).toThrow('truncated payload');
    expect(() => decodeInsn(Uint16Array.of(0x0100, 9, 0), 0)).toThrow('past end');
  });
  it('remaps every kind of constant-pool index and detects overflow', () => {
    const code = new CodeBuilder({ registers: 4 })
      .op('const-string', 0, 1).op('const-string/jumbo', 0, 2).op('new-instance', 0, 3).op('iget', 0, 1, 4).op('sput', 0, 5)
      .op('invoke-virtual', 6, 0).op('invoke-static/range', 7, 0, 1).op('filled-new-array', 8, 0)
      .op('invoke-polymorphic', 9, 10, 0).op('invoke-polymorphic/range', 11, 12, 0, 1).op('const-method-type', 0, 13).op('const-method-handle', 0, 14)
      .op('invoke-custom', 15, 0).op('return-void').build(0).insns;
    const m = { string: (i: number) => i + 100, type: (i: number) => i + 200, field: (i: number) => i + 300, method: (i: number) => i + 400, proto: (i: number) => i + 500 };
    const out = decodeAll(remapInsns(code, m));
    expect(out.filter((i) => i.ref).map((i) => [i.ref!.kind, i.ref!.index])).toEqual([
      ['string', 101], ['string', 102], ['type', 203], ['field', 304], ['field', 305], ['method', 406], ['method', 407], ['type', 208], ['method', 409], ['method', 411],
    ]);
    const poly = out.find((i) => i.name === 'invoke-polymorphic')!;
    expect(poly.operands[1]).toBe(510);
    expect(out.find((i) => i.name === 'invoke-polymorphic/range')!.operands[1]).toBe(512);
    expect(out.find((i) => i.name === 'const-method-type')!.operands[1]).toBe(513);
    expect(out.find((i) => i.name === 'const-method-handle')!.operands[1]).toBe(14);
    expect(out.find((i) => i.name === 'invoke-custom')!.operands[0]).toBe(15);
    const jumbo = decodeAll(remapInsns(new CodeBuilder({ registers: 1 }).op('const-string/jumbo', 0, 1).build(0).insns, { ...m, string: () => 0x12345 }))[0]!;
    expect(jumbo.ref!.index).toBe(0x12345);
    expect(() => remapInsns(new CodeBuilder({ registers: 1 }).op('const-string', 0, 1).build(0).insns, { ...m, string: () => 0x10000 })).toThrow('no longer fits');
  });
});

describe('CodeBuilder', () => {
  const b = (regs = 8) => new CodeBuilder({ registers: regs, outs: 2 });
  it('resolves forward and backward labels in every branch format', () => {
    const c = b().label('top').op('nop').op('goto', 'end').op('goto/16', 'top').op('goto/32', 'end').op('if-eqz', 0, 'top').op('if-eq', 0, 1, 'end')
      .op('fill-array-data', 0, 'end').op('goto', 3).label('end').op('return-void').build(1);
    const d = decodeAll(c.insns);
    expect(d.slice(1, 8).map((i) => i.operands.at(-1))).toEqual([14, -2, 11, -7, 6, 4, 3]);
    expect(c.ins).toBe(1);
    expect(c.outs).toBe(2);
  });
  it('builds try/catch tables sorted by start', () => {
    const c = b().label('a').op('nop').label('b').op('nop').label('c').op('return-void').label('h').op('move-exception', 0).op('return-void')
      .tryCatch({ start: 'b', end: 'c', catchAll: 'h' }).tryCatch({ start: 'a', end: 'b', handlers: [{ type: 7, label: 'h' }], catchAll: 'h' }).build(0);
    expect(c.tries).toEqual([{ start: 0, count: 1, handler: 1 }, { start: 1, count: 1, handler: 0 }]);
    expect(c.handlers[1]).toEqual({ catches: [{ type: 7, addr: 3 }], catchAll: 3 });
  });
  it('validates operands', () => {
    expect(() => opByName('bogus')).toThrow('unknown opcode');
    expect(() => b().op('nop', 1).build(0)).toThrow('takes 0 operands');
    expect(() => b().op('move', 16, 0).build(0)).toThrow('does not fit');
    expect(() => b().op('move', 1.5, 0).build(0)).toThrow('expected an integer');
    expect(() => b().op('const/4', 0, 9).build(0)).toThrow('does not fit');
    expect(() => b().op('const/16', 0, 40000).build(0)).toThrow('does not fit');
    expect(() => b().op('const-string', 0, 70000).build(0)).toThrow('does not fit');
    expect(() => b().op('goto', 'nowhere').build(0)).toThrow('undefined label');
    expect(() => b().op('goto', 1000).build(0)).toThrow('does not fit');
    expect(() => { const x = b().op('goto', 'far'); for (let i = 0; i < 200; i++) x.op('nop'); x.label('far').build(0); }).toThrow('branch to far');
    expect(() => b().label('x').label('x')).toThrow('duplicate label');
    expect(() => b().op('invoke-virtual').build(0)).toThrow('up to 5 registers');
    expect(() => b().op('invoke-virtual', 1, 1, 2, 3, 4, 5, 6).build(0)).toThrow('up to 5 registers');
    expect(() => b().op('invoke-polymorphic', 1).build(0)).toThrow('method, proto');
    expect(() => b().op('const-wide', 0, 'x').build(0)).toThrow('number or bigint');
    expect(() => b().op('invoke-virtual/range', 1, 0, 300).build(0)).toThrow('does not fit');
    expect(() => b().op('return-void').tryCatch({ start: 'a', end: 'b' }).build(0)).toThrow('undefined label');
    expect(() => b().label('a').op('nop').label('b').tryCatch({ start: 'b', end: 'a', catchAll: 'a' }).build(0)).toThrow('empty try range');
    expect(() => b().label('a').op('nop').label('b').tryCatch({ start: 'a', end: 'b' }).build(0)).toThrow('without handlers');
    expect(() => b(2).op('move', 5, 0).build(0)).toThrow('only 2 registers declared');
    expect(() => b(2).op('return-void').build(3)).toThrow('argument registers');
    expect(() => b().label('a').op('nop').label('z').tryCatch({ start: 'a', end: 'z', catchAll: 'q' }).build(0)).toThrow('undefined label q');
  });
  it('uses defaults for outs and 64-bit literals', () => {
    const c = new CodeBuilder({ registers: 1 }).op('const-wide', 0, 5).op('const-wide', 0, -1n).build(0);
    expect(c.outs).toBe(0);
    expect(decodeAll(c.insns).map((i) => i.wide)).toEqual([5n, -1n]);
  });
});
