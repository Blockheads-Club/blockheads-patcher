import { describe, it, expect } from 'vitest';
import { ACC, CodeBuilder, DexError, DexFile, decodeAll, validateDex } from '../../src/dex';
import { buildDex } from './fixture';
import { canon } from './canon';
import { richDex, richSpec, BASE, DERIVED } from './samples';
import { H, locate, reseal, setU16, setU32, u32 } from './util';

const STR = 'Ljava/lang/String;';
const roundTrip = (b: Uint8Array): Uint8Array => DexFile.parse(b).serialize();
const block = (lines: string[], header: string): [number, number] => {
  const s = lines.findIndex((l) => l === header);
  let e = s + 1;
  while (e < lines.length && lines[e]!.startsWith('    ')) e++;
  return [s, e];
};
const ok = (b: Uint8Array): void => expect(validateDex(b)).toEqual([]);

describe('parse and serialize', () => {
  it('preserves every item kind (annotations, static values, debug info, try/catch, payloads, interfaces)', () => {
    const src = richDex();
    ok(src);
    const out = roundTrip(src);
    ok(out);
    expect(canon(out)).toEqual(canon(src));
    expect(canon(src).join('\n')).toContain('try 12+8 any->61');
    // idempotent and deterministic
    expect(roundTrip(out)).toEqual(out);
    expect(canon(roundTrip(out))).toEqual(canon(src));
  });
  it('keeps the dex version and works for 038/039 headers', () => {
    for (const version of ['037', '039']) {
      const out = roundTrip(buildDex({ ...richSpec(), version }));
      expect(String.fromCharCode(...out.subarray(4, 7))).toBe(version);
      ok(out);
    }
  });
  it('handles a dex with no classes and no data items', () => {
    const out = roundTrip(buildDex({ classes: [] }));
    ok(out);
    expect(DexFile.parse(out).classNames()).toEqual([]);
  });
  it('exposes classes and methods', () => {
    const d = DexFile.parse(richDex());
    expect(d.classNames().sort()).toEqual(['Lcom/ex/Ann;', BASE, DERIVED, 'Lcom/ex/Empty;', 'Lcom/ex/Iface;']);
    const base = d.findClass(BASE)!;
    expect(base.descriptor).toBe(BASE);
    expect(base.superclass).toBe('Ljava/lang/Object;');
    expect(base.interfaces).toEqual(['Ljava/lang/Runnable;']);
    expect(base.accessFlags).toBe(1);
    expect(d.findClass('Lnope;')).toBeUndefined();
    expect(d.findClass('Lcom/ex/Never;')).toBeUndefined();
    const run = base.findMethod('run', [], 'V')!;
    expect(run).toMatchObject({ name: 'run', params: [], returnType: 'V', direct: false, hasCode: true });
    expect(base.findMethod('run')).toBeDefined();
    expect(base.findMethod('run', ['I'])).toBeUndefined();
    expect(base.findMethod('run', [], 'I')).toBeUndefined();
    expect(base.findMethod('abstractOne')!.hasCode).toBe(false);
    expect(base.findMethod('<init>')!.direct).toBe(true);
    expect(d.findClass('Lcom/ex/Empty;')!.methods()).toEqual([]);
    expect(d.subclassesOf(BASE).map((c) => c.descriptor)).toEqual([DERIVED]);
    expect(d.classes().length).toBe(5);
    expect(DexFile.parse(buildDex({ classes: [{ name: 'La/Root;', super: null }] })).findClass('La/Root;')!.superclass).toBeNull();
    expect(() => d.text(99999)).toThrow('out of range');
  });
});

describe('constant pool growth', () => {
  it('inserts strings, types, protos, fields and methods in sorted position and remaps every reference', () => {
    const src = richDex();
    const d = DexFile.parse(src);
    const first = d.string('\u0000-first'), last = d.string('￿-last');
    d.type('Laaa/First;'); d.type('Lzzz/Last;'); d.type('[[J');
    const p = d.proto('I', ['J', '[Ljava/lang/String;']);
    expect(d.proto('I', ['J', '[Ljava/lang/String;'])).toBe(p);
    d.field('Laaa/First;', 'x', 'I'); d.method('Lzzz/Last;', 'm', 'V', []);
    d.method('Lzzz/Last;', 'm', 'V', []); // duplicate returns the same id
    expect(d.string('\u0000-first')).toBe(first);
    expect(d.type('Laaa/First;')).toBe(d.type('Laaa/First;'));
    expect(last).toBeGreaterThan(first);
    d.dirty = true;
    const out = d.serialize();
    ok(out);
    expect(canon(out)).toEqual(canon(src));
    const back = DexFile.parse(out);
    expect(back.text(0)).toBe('\u0000-first');
    expect(back.text(back.strings.length - 1)).toBe('￿-last');
    expect(back.findClass(BASE)).toBeDefined();
    expect(back.methods.length).toBe(DexFile.parse(src).methods.length + 1);
  });
  it('rejects malformed descriptors', () => {
    const d = DexFile.parse(richDex());
    for (const bad of ['', 'Lfoo', 'II', 'java.lang.String', 'L;', '[']) expect(() => d.type(bad)).toThrow('invalid type descriptor');
    expect(d.type('V')).toBeGreaterThanOrEqual(0);
  });
  it('fails clearly when ids outgrow 16 bits', () => {
    const many = (): DexFile => {
      const d = DexFile.parse(buildDex({ classes: [{ name: 'La/A;' }] }));
      for (let i = 0; i < 70000; i++) d.types.push(d.types[0]!);
      return d;
    };
    const a = many();
    a.fields.push({ cls: 69999, type: 0, name: 0 });
    expect(() => a.serialize()).toThrow('too many types');
    const b = many();
    b.protos.push({ shorty: 0, ret: 0, params: [69999] });
    expect(() => b.serialize()).toThrow('too many types');
    const c = DexFile.parse(buildDex({ classes: [{ name: 'La/A;' }] }));
    for (let i = 0; i < 70000; i++) c.protos.push({ shorty: 0, ret: 0, params: [] });
    c.methods.push({ cls: 0, proto: 69999, name: 0 });
    expect(() => c.serialize()).toThrow('too many protos');
  });
  it('reports dangling indices', () => {
    const d = DexFile.parse(richDex());
    const base = d.findClass(BASE)!;
    base.replaceBody(base.findMethod('setLabel')!, new CodeBuilder({ registers: 3 }).op('const-string', 0, 5000).op('return-void'));
    expect(() => d.serialize()).toThrow('string index 5000 out of range');
  });
});

describe('editing', () => {
  it('replaces a method body and leaves everything else byte-for-byte equivalent', () => {
    const src = richDex();
    const d = DexFile.parse(src);
    const base = d.findClass(BASE)!;
    const code = new CodeBuilder({ registers: 3, outs: 2 })
      .op('const-string', 0, d.string('patched'))
      .op('sget-object', 1, d.field(BASE, 'NAME', STR))
      .op('invoke-virtual', d.method(STR, 'equals', 'Z', ['Ljava/lang/Object;']), 0, 1)
      .op('return-void');
    base.replaceBody(base.findMethod('run')!, code);
    expect(d.dirty).toBe(true);
    const out = d.serialize();
    ok(out);
    const before = canon(src), after = canon(out);
    const [s, e] = block(before, '  virtual Lcom/ex/Base;.runV() flags=1');
    const [s2, e2] = block(after, '  virtual Lcom/ex/Base;.runV() flags=1');
    expect(after.slice(0, s2)).toEqual(before.slice(0, s));
    expect(after.slice(e2)).toEqual(before.slice(e));
    expect(after.slice(s2 + 1, e2)).toEqual([
      '    code regs=3 ins=1 outs=2 dbg=-', '      0: const-string 0 "patched"', '      2: sget-object 1 Lcom/ex/Base;.NAME:Ljava/lang/String;',
      '      4: invoke-virtual 0,1 Ljava/lang/String;.equalsZ(Ljava/lang/Object;)', '      7: return-void',
    ]);
    // editing a patched file again works (the output is a normal dex)
    const d2 = DexFile.parse(out);
    d2.findClass(BASE)!.replaceBody(d2.findClass(BASE)!.findMethod('run')!, new CodeBuilder({ registers: 1 }).op('return-void'));
    ok(d2.serialize());
  });
  it('replaceBody computes ins from the signature (wide arguments, static methods)', () => {
    const d = DexFile.parse(buildDex({ classes: [{ name: 'La/A;', direct: [{ name: 's', ret: 'V', params: ['J', 'D', 'I'], flags: 9, code: { regs: 6, ins: 5, outs: 0, insns: [0x000e] } }] }] }));
    const cls = d.findClass('La/A;')!;
    cls.replaceBody(cls.findMethod('s')!, new CodeBuilder({ registers: 6 }).op('return-void'));
    const out = d.serialize();
    expect(canon(out).join('\n')).toContain('code regs=6 ins=5 outs=0');
    const d2 = DexFile.parse(buildDex({ classes: [{ name: 'La/A;', direct: [{ name: 's', ret: 'V', params: ['J'], flags: 9, code: { regs: 2, ins: 2, outs: 0, insns: [0x000e] } }] }] }));
    const c2 = d2.findClass('La/A;')!;
    expect(() => c2.replaceBody(c2.findMethod('s')!, new CodeBuilder({ registers: 1 }).op('return-void'))).toThrow('argument registers');
  });
  it('refuses to replace the body of an abstract method', () => {
    const d = DexFile.parse(richDex());
    const base = d.findClass(BASE)!;
    expect(() => base.replaceBody(base.findMethod('abstractOne')!, new CodeBuilder({ registers: 5 }).op('return-void'))).toThrow('no code');
  });
  it('adds virtual, direct and abstract methods to existing classes (also to a class without class data)', () => {
    const src = richDex();
    const d = DexFile.parse(src);
    const base = d.findClass(BASE)!;
    const v = base.addMethod({ name: 'added', returnType: 'I', params: ['J'], access: ACC.PUBLIC, code: new CodeBuilder({ registers: 4 }).op('const/4', 0, 0).op('return', 0) });
    const s = base.addMethod({ name: 'helper', returnType: 'V', params: [], access: ACC.PUBLIC | ACC.STATIC, code: new CodeBuilder({ registers: 1 }).op('return-void') });
    expect([v.direct, s.direct, v.hasCode]).toEqual([false, true, true]);
    const empty = d.findClass('Lcom/ex/Empty;')!;
    empty.addMethod({ name: 'init', returnType: 'V', params: [], access: ACC.PRIVATE | ACC.CONSTRUCTOR, code: new CodeBuilder({ registers: 1 }).op('return-void') });
    const iface = d.findClass('Lcom/ex/Iface;')!;
    expect(iface.addMethod({ name: 'more', returnType: 'V', params: [], access: ACC.PUBLIC | ACC.ABSTRACT }).hasCode).toBe(false);
    const out = d.serialize();
    ok(out);
    const after = canon(out).join('\n');
    expect(after).toContain('virtual Lcom/ex/Base;.addedI(J) flags=1');
    expect(after).toContain('direct Lcom/ex/Base;.helperV() flags=9');
    expect(after).toContain('direct Lcom/ex/Empty;.initV() flags=65538');
    expect(after).toContain('virtual Lcom/ex/Iface;.moreV() flags=1025');
    const before = canon(src).join('\n');
    for (const line of before.split('\n')) expect(after).toContain(line);
    const back = DexFile.parse(out).findClass(BASE)!;
    expect(back.findMethod('added', ['J'], 'I')!.hasCode).toBe(true);
  });
  it('validates addMethod', () => {
    const d = DexFile.parse(richDex());
    const base = d.findClass(BASE)!;
    const code = (): CodeBuilder => new CodeBuilder({ registers: 1 }).op('return-void');
    expect(() => base.addMethod({ name: 'x', returnType: 'V', params: [], access: ACC.PUBLIC })).toThrow('code is required');
    expect(() => base.addMethod({ name: 'x', returnType: 'V', params: [], access: ACC.PUBLIC | ACC.NATIVE, code: code() })).toThrow('forbidden');
    expect(() => base.addMethod({ name: 'run', returnType: 'V', params: [], access: ACC.PUBLIC, code: code() })).toThrow('already exists');
  });
  it('adds a new helper class, including to a dex whose existing classes it extends', () => {
    const src = richDex();
    const d = DexFile.parse(src);
    const cls = d.addClass({ descriptor: 'Lcom/new/Helper;', superclass: BASE, interfaces: ['Ljava/lang/Runnable;'], sourceFile: 'Helper.java', access: ACC.PUBLIC | ACC.FINAL });
    cls.addMethod({ name: 'twice', returnType: 'I', params: ['I'], access: ACC.PUBLIC | ACC.STATIC, code: new CodeBuilder({ registers: 2 }).op('add-int', 0, 1, 1).op('return', 0) });
    const plain = d.addClass({ descriptor: 'Lcom/new/Plain;' });
    expect(plain.superclass).toBe('Ljava/lang/Object;');
    expect(plain.interfaces).toEqual([]);
    expect(d.findClass('Lcom/new/Helper;')!.descriptor).toBe('Lcom/new/Helper;');
    expect(() => d.addClass({ descriptor: 'Lcom/new/Helper;' })).toThrow('already exists');
    const out = d.serialize();
    ok(out);
    const lines = canon(out);
    expect(lines).toContain('class Lcom/new/Helper; flags=17 super=Lcom/ex/Base; ifaces=[Ljava/lang/Runnable;] source=Helper.java');
    expect(lines).toContain('class Lcom/new/Plain; flags=1 super=Ljava/lang/Object; ifaces=[] source=-');
    expect(lines.join('\n')).toContain('direct Lcom/new/Helper;.twiceI(I) flags=9');
    const old = canon(src);
    expect(lines.slice(0, old.length)).toEqual(old);
  });
});

describe('malformed input', () => {
  const protoWithParams = (b: Uint8Array): number => {
    for (let i = 0; i < u32(b, H.nProto); i++) if (u32(b, u32(b, H.oProto) + 12 * i + 8)) return u32(b, u32(b, H.oProto) + 12 * i + 8);
    throw new Error('fixture has no proto with parameters');
  };
  it.each<[string, (b: Uint8Array) => void, string]>([
    ['bad magic', (b) => { b[0] = 0; }, 'not a dex file'],
    ['bad terminator', (b) => { b[7] = 1; }, 'not a dex file'],
    ['truncated header', () => undefined, 'not a dex file'],
    ['unsupported version', (b) => { b[5] = 0x30; b[6] = 0x30; }, 'unsupported dex version'],
    ['wrong size', (b) => setU32(b, 0x20, 5), 'file size'],
    ['bad header size', (b) => setU32(b, 0x24, 0x71), 'header size'],
    ['big endian', (b) => setU32(b, 0x28, 0x78563412), 'endianness'],
    ['link data', (b) => setU32(b, 0x2c, 8), 'link data'],
    ['table beyond file', (b) => setU32(b, H.oStr, 0x7fffff00), 'out of bounds'],
    ['string offset beyond file', (b) => setU32(b, u32(b, H.oStr), 0x7fffff00), 'string data out of bounds'],
    ['unterminated string', (b) => { setU32(b, u32(b, H.oStr), b.length - 2); b[b.length - 2] = 1; b[b.length - 1] = 1; }, 'unterminated string'],
    ['type descriptor index', (b) => setU32(b, u32(b, H.oType), 99999), 'string index 99999'],
    ['proto shorty index', (b) => setU32(b, u32(b, H.oProto), 99999), 'string index 99999'],
    ['proto return type', (b) => setU32(b, u32(b, H.oProto) + 4, 99999), 'type index 99999'],
    ['type list entry', (b) => setU16(b, protoWithParams(b) + 4, 9999), 'type index out of range'],
    ['field class', (b) => setU16(b, u32(b, H.oField), 9999), 'type index 9999'],
    ['field name', (b) => setU32(b, u32(b, H.oField) + 4, 99999), 'string index 99999'],
    ['method proto', (b) => setU16(b, u32(b, H.oMeth) + 2, 9999), 'proto index 9999'],
    ['class type', (b) => setU32(b, u32(b, H.oCls), 9999), 'type index 9999'],
    ['superclass', (b) => setU32(b, u32(b, H.oCls) + 8, 9999), 'type index 9999'],
    ['source file', (b) => setU32(b, u32(b, H.oCls) + 16, 99999), 'string index 99999'],
    ['call sites', (b) => setU16(b, u32(b, H.mapOff) === 0 ? 0 : u32(b, H.mapOff) + 4, 7), 'unsupported map item 0x7'],
    ['hidden api data', (b) => setU16(b, u32(b, H.mapOff) + 4, 0xf000), 'unsupported map item 0xf000'],
  ])('%s', (name, fn, msg) => {
    const b = name === 'truncated header' ? richDex().slice(0, 40) : (() => { const x = richDex().slice(); fn(x); return x; })();
    expect(() => DexFile.parse(b)).toThrow(msg);
    expect(() => DexFile.parse(b)).toThrow(DexError);
  });
  it('detects bad class data lazily', () => {
    const b = richDex().slice();
    b[locate(b, 0).classData + 4] = 0x7f;
    const d = DexFile.parse(b);
    expect(() => d.findClass(BASE)!.methods()).toThrow('member index out of range');
  });
  it('rejects unknown catch handler offsets and encoded value types while editing', () => {
    const tiny = (): Uint8Array => buildDex({ classes: [{ name: 'La/A;', values: [{ k: 'byte', v: 0x5a }], virtual: [{ name: 'm', ret: 'V', params: [], flags: 1, code: {
      regs: 1, ins: 1, outs: 0, insns: [0x000e], tries: [{ start: 0, count: 1, handler: 0 }], handlers: [{ catches: [], catchAll: 0 }] } }] }] });
    const code = locate(tiny(), 0).methods[0]!.code;
    const bad = tiny();
    setU16(bad, code + 16 + 4 + 6, 0x33); // try.handler_off (header 16 + insns 2 + pad 2 + start 4 + count 2)
    expect(() => DexFile.parse(bad).findClass('La/A;')!.methods()).toThrow('bad catch handler offset');
    const v = tiny();
    const at = v.findIndex((x, i) => x === 1 && v[i + 1] === 0 && v[i + 2] === 0x5a);
    v[at + 1] = 0x05;
    expect(() => DexFile.parse(v).serialize()).toThrow('bad encoded value type');
  });
});

describe('ties, wide indexes and optional fields', () => {
  it('orders overloads and same-named fields, and re-encodes indexes needing several bytes', () => {
    const spec = richSpec();
    spec.extraStrings = Array.from({ length: 700 }, (_, i) => `a${String(i).padStart(4, '0')}`);
    spec.classes.push({ name: 'Lcom/ex/Root;', super: null, direct: [{ name: 'd', ret: 'V', params: [], flags: 9, code: { regs: 1, ins: 0, outs: 0, insns: [0x000e], debug: { line: 1, params: [], ops: [['startLocal', 0, null, null], ['setFile', null]] } } },
      { name: 'e', ret: 'V', params: ['I'], flags: 9, code: { regs: 1, ins: 1, outs: 0, insns: [0x000e], debug: { line: 1, params: [null, 'a0001'], ops: [] } } }] });
    const src = buildDex(spec);
    const d = DexFile.parse(src);
    d.field(BASE, 'COUNT', 'J'); d.method(BASE, 'run', 'V', ['I']); d.method(BASE, 'run', 'I', []);
    d.dirty = true;
    const out = d.serialize();
    ok(src); ok(out);
    expect(canon(out)).toEqual(canon(src));
    expect(canon(roundTrip(src))).toEqual(canon(src));
  });
});

describe('class order', () => {
  it('keeps new classes after the existing ones so superclasses stay first', () => {
    const d = DexFile.parse(richDex());
    d.addClass({ descriptor: 'Lz/Late;', superclass: DERIVED });
    d.addClass({ descriptor: 'La/Early;', superclass: 'Lz/Late;' });
    const out = d.serialize();
    ok(out);
    expect(DexFile.parse(out).classNames().slice(-2)).toEqual(['Lz/Late;', 'La/Early;']);
  });
});
