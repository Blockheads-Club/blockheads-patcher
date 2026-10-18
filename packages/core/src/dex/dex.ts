import { ByteReader, DexError } from './bytes';
import type { CodeData, CodeBuilder, CodeHandler, CodeTry } from './assembler';
import { decodeMutf8, encodeMutf8 } from './mutf8';
import { HEADER_SIZE, NO_INDEX } from './consts';
import { writeDex } from './write';

export const ACC = { PUBLIC: 1, PRIVATE: 2, PROTECTED: 4, STATIC: 8, FINAL: 0x10, SYNCHRONIZED: 0x20, NATIVE: 0x100, ABSTRACT: 0x400, SYNTHETIC: 0x1000, CONSTRUCTOR: 0x10000 } as const;

export interface StringEntry { bytes: Uint8Array; text?: string }
export interface ProtoId { shorty: number; ret: number; params: number[] }
export interface FieldId { cls: number; type: number; name: number }
export interface MethodId { cls: number; proto: number; name: number }
export interface EncodedField { idx: number; flags: number }
export interface EncodedMethod { idx: number; flags: number; code: CodeItem | null }
/** A method body. `debugOff` is the offset of the debug_info_item in the source dex (0 = none). */
export interface CodeItem extends CodeData { debugOff: number }
export interface ClassData {
  staticFields: EncodedField[];
  instanceFields: EncodedField[];
  directMethods: EncodedMethod[];
  virtualMethods: EncodedMethod[];
}
export interface ClassDef {
  type: number;
  flags: number;
  superclass: number;
  interfaces: number[];
  sourceFile: number;
  annotationsOff: number;
  classDataOff: number;
  staticValuesOff: number;
  /** Parsed (or newly created) class data; undefined until first needed. */
  data?: ClassData;
}

export interface MethodInfo {
  /** Provisional method_ids index. */
  idx: number;
  name: string;
  params: string[];
  returnType: string;
  access: number;
  direct: boolean;
  hasCode: boolean;
}
export interface MethodSpec {
  name: string;
  returnType: string;
  params: string[];
  access: number;
  /** Required unless the method is abstract or native. */
  code?: CodeBuilder;
}
export interface ClassSpec {
  descriptor: string;
  access?: number;
  superclass?: string;
  interfaces?: string[];
  sourceFile?: string;
}

const MAGIC = [0x64, 0x65, 0x78, 0x0a];

/** In-memory, editable DEX file. Constant-pool indices held by this model are provisional; `serialize()` sorts and remaps them. */
export class DexFile {
  version = '035';
  strings: StringEntry[] = [];
  types: number[] = [];
  protos: ProtoId[] = [];
  fields: FieldId[] = [];
  methods: MethodId[] = [];
  classDefs: ClassDef[] = [];
  /** Entry counts at parse time (appended ids are the provisional indices beyond these). */
  orig = { strings: 0, types: 0, protos: 0, fields: 0, methods: 0 };
  /** True once any edit was made. */
  dirty = false;
  private idx?: { str: Map<string, number>; type: Map<number, number>; proto: Map<string, number>; field: Map<string, number>; method: Map<string, number>; cls: Map<number, ClassDef> };

  private constructor(readonly src: Uint8Array) {}

  /** Parses id tables and class definitions (class data and code are parsed on demand). Throws DexError on malformed input. */
  static parse(src: Uint8Array): DexFile {
    const d = new DexFile(src);
    const r = new ByteReader(src);
    if (src.length < HEADER_SIZE || MAGIC.some((b, i) => src[i] !== b) || src[7] !== 0) throw new DexError('not a dex file');
    d.version = String.fromCharCode(src[4]!, src[5]!, src[6]!);
    if (!/^03[5-9]$/.test(d.version)) throw new DexError(`unsupported dex version ${d.version}`);
    r.pos = 0x20;
    if (r.u32() !== src.length) throw new DexError('file size mismatch');
    if (r.u32() !== HEADER_SIZE) throw new DexError('bad header size');
    if (r.u32() !== 0x12345678) throw new DexError('unsupported endianness');
    if (r.u32() !== 0) throw new DexError('dex link data is not supported');
    r.pos += 4;
    const mapOff = r.u32();
    const tab = (): [number, number] => [r.u32(), r.u32()];
    const [nStr, offStr] = tab(), [nType, offType] = tab(), [nProto, offProto] = tab(), [nField, offField] = tab(), [nMeth, offMeth] = tab(), [nCls, offCls] = tab();
    d.checkMap(mapOff);

    const at = (off: number, size: number, n: number): ByteReader => {
      if (off + size * n > src.length) throw new DexError('id table out of bounds');
      return new ByteReader(src, off);
    };
    const chk = (v: number, n: number, what: string): number => {
      if (v >= n) throw new DexError(`${what} index ${v} out of range`);
      return v;
    };
    let t = at(offStr, 4, nStr);
    for (let i = 0; i < nStr; i++) {
      const so = t.u32();
      if (so >= src.length) throw new DexError('string data out of bounds');
      const sr = new ByteReader(src, so);
      sr.uleb();
      const end = src.indexOf(0, sr.pos);
      if (end < 0) throw new DexError('unterminated string');
      d.strings.push({ bytes: src.subarray(sr.pos, end) });
    }
    t = at(offType, 4, nType);
    for (let i = 0; i < nType; i++) d.types.push(chk(t.u32(), nStr, 'string'));
    t = at(offProto, 12, nProto);
    for (let i = 0; i < nProto; i++) {
      const shorty = chk(t.u32(), nStr, 'string'), ret = chk(t.u32(), nType, 'type'), po = t.u32();
      d.protos.push({ shorty, ret, params: po ? d.typeList(po, nType) : [] });
    }
    t = at(offField, 8, nField);
    for (let i = 0; i < nField; i++) d.fields.push({ cls: chk(t.u16(), nType, 'type'), type: chk(t.u16(), nType, 'type'), name: chk(t.u32(), nStr, 'string') });
    t = at(offMeth, 8, nMeth);
    for (let i = 0; i < nMeth; i++) d.methods.push({ cls: chk(t.u16(), nType, 'type'), proto: chk(t.u16(), nProto, 'proto'), name: chk(t.u32(), nStr, 'string') });
    t = at(offCls, 32, nCls);
    const opt = (v: number, n: number, what: string): number => (v === NO_INDEX ? -1 : chk(v, n, what));
    for (let i = 0; i < nCls; i++) {
      const type = chk(t.u32(), nType, 'type'), flags = t.u32(), superclass = opt(t.u32(), nType, 'type'), io = t.u32(), sf = opt(t.u32(), nStr, 'string');
      const annotationsOff = t.u32(), classDataOff = t.u32(), staticValuesOff = t.u32();
      d.classDefs.push({ type, flags, superclass, interfaces: io ? d.typeList(io, nType) : [], sourceFile: sf, annotationsOff, classDataOff, staticValuesOff });
    }
    d.orig = { strings: nStr, types: nType, protos: nProto, fields: nField, methods: nMeth };
    return d;
  }

  /** Rejects dex files that use features this editor cannot rewrite (call sites, method handles, hidden-API data). */
  private checkMap(mapOff: number): void {
    const r = new ByteReader(this.src, mapOff);
    const n = r.u32();
    for (let i = 0; i < n; i++) {
      const type = r.u16();
      r.pos += 10;
      if (type === 0x0007 || type === 0x0008 || type === 0xf000) throw new DexError(`unsupported map item 0x${type.toString(16)}`);
    }
  }

  private typeList(off: number, nType: number): number[] {
    const r = new ByteReader(this.src, off);
    const n = r.u32();
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = r.u16();
      if (v >= nType) throw new DexError('type index out of range');
      out.push(v);
    }
    return out;
  }

  // ---- lookups -------------------------------------------------------------------------------------------------

  text(i: number): string {
    const s = this.strings[i];
    if (!s) throw new DexError(`string index ${i} out of range`);
    return (s.text ??= decodeMutf8(s.bytes));
  }
  typeName(i: number): string { return this.text(this.types[i]!); }

  private index(): NonNullable<DexFile['idx']> {
    if (this.idx) return this.idx;
    const idx = { str: new Map<string, number>(), type: new Map<number, number>(), proto: new Map<string, number>(), field: new Map<string, number>(), method: new Map<string, number>(), cls: new Map<number, ClassDef>() };
    this.strings.forEach((_, i) => idx.str.set(this.text(i), i));
    this.types.forEach((s, i) => idx.type.set(s, i));
    this.protos.forEach((p, i) => idx.proto.set(`${p.ret}:${p.params.join(',')}`, i));
    this.fields.forEach((f, i) => idx.field.set(`${f.cls}:${f.name}:${f.type}`, i));
    this.methods.forEach((m, i) => idx.method.set(`${m.cls}:${m.name}:${m.proto}`, i));
    this.classDefs.forEach((c) => idx.cls.set(c.type, c));
    return (this.idx = idx);
  }

  /** Returns the provisional index of a string, adding it when absent. */
  string(text: string): number {
    const ix = this.index();
    let i = ix.str.get(text);
    if (i === undefined) {
      i = this.strings.length;
      this.strings.push({ bytes: encodeMutf8(text), text });
      ix.str.set(text, i);
      this.dirty = true;
    }
    return i;
  }

  type(descriptor: string): number {
    if (!/^(\[*([VZBSCIJFD]|L[^;\s]+;))$/.test(descriptor)) throw new DexError(`invalid type descriptor ${descriptor}`);
    const ix = this.index();
    const s = this.string(descriptor);
    let i = ix.type.get(s);
    if (i === undefined) {
      i = this.types.length;
      this.types.push(s);
      ix.type.set(s, i);
    }
    return i;
  }

  proto(returnType: string, params: string[]): number {
    const ix = this.index();
    const ret = this.type(returnType), ps = params.map((p) => this.type(p));
    const key = `${ret}:${ps.join(',')}`;
    let i = ix.proto.get(key);
    if (i === undefined) {
      const sh = [returnType, ...params].map((t) => (t[0] === '[' ? 'L' : t[0]!)).join('');
      i = this.protos.length;
      this.protos.push({ shorty: this.string(sh), ret, params: ps });
      ix.proto.set(key, i);
    }
    return i;
  }

  field(cls: string, name: string, type: string): number {
    const ix = this.index();
    const f = { cls: this.type(cls), name: this.string(name), type: this.type(type) };
    const key = `${f.cls}:${f.name}:${f.type}`;
    let i = ix.field.get(key);
    if (i === undefined) {
      i = this.fields.length;
      this.fields.push(f);
      ix.field.set(key, i);
    }
    return i;
  }

  method(cls: string, name: string, returnType: string, params: string[]): number {
    const ix = this.index();
    const m = { cls: this.type(cls), name: this.string(name), proto: this.proto(returnType, params) };
    const key = `${m.cls}:${m.name}:${m.proto}`;
    let i = ix.method.get(key);
    if (i === undefined) {
      i = this.methods.length;
      this.methods.push(m);
      ix.method.set(key, i);
    }
    return i;
  }

  // ---- classes -------------------------------------------------------------------------------------------------

  /** Descriptors of all classes defined in this dex. */
  classNames(): string[] { return this.classDefs.map((c) => this.typeName(c.type)); }

  classes(): DexClass[] { return this.classDefs.map((c) => new DexClass(this, c)); }

  /** Classes defined here whose direct superclass is `descriptor`. */
  subclassesOf(descriptor: string): DexClass[] {
    return this.classes().filter((c) => c.superclass === descriptor);
  }

  findClass(descriptor: string): DexClass | undefined {
    const ix = this.index();
    const s = ix.str.get(descriptor);
    const ti = s === undefined ? undefined : ix.type.get(s);
    const def = ti === undefined ? undefined : ix.cls.get(ti);
    return def && new DexClass(this, def);
  }

  /** Adds a new, empty class definition (superclass defaults to java.lang.Object) and returns it for adding members. */
  addClass(spec: ClassSpec): DexClass {
    const ix = this.index();
    const type = this.type(spec.descriptor);
    if (ix.cls.has(type)) throw new DexError(`class ${spec.descriptor} already exists`);
    const def: ClassDef = {
      type, flags: spec.access ?? ACC.PUBLIC, superclass: this.type(spec.superclass ?? 'Ljava/lang/Object;'),
      interfaces: (spec.interfaces ?? []).map((i) => this.type(i)), sourceFile: spec.sourceFile === undefined ? -1 : this.string(spec.sourceFile),
      annotationsOff: 0, classDataOff: 0, staticValuesOff: 0,
      data: { staticFields: [], instanceFields: [], directMethods: [], virtualMethods: [] },
    };
    this.classDefs.push(def);
    ix.cls.set(type, def);
    this.dirty = true;
    return new DexClass(this, def);
  }

  /** Class data of a definition, parsed on first use. */
  classData(def: ClassDef): ClassData {
    if (def.data) return def.data;
    const data: ClassData = { staticFields: [], instanceFields: [], directMethods: [], virtualMethods: [] };
    if (def.classDataOff) {
      const r = new ByteReader(this.src, def.classDataOff);
      const [ns, ni, nd, nv] = [r.uleb(), r.uleb(), r.uleb(), r.uleb()];
      const fields = (n: number): EncodedField[] => {
        let idx = 0;
        return Array.from({ length: n }, () => { idx += r.uleb(); return { idx, flags: r.uleb() }; });
      };
      const meths = (n: number): EncodedMethod[] => {
        let idx = 0;
        return Array.from({ length: n }, () => {
          idx += r.uleb();
          const flags = r.uleb(), co = r.uleb();
          return { idx, flags, code: co ? this.codeItem(co) : null };
        });
      };
      data.staticFields = fields(ns);
      data.instanceFields = fields(ni);
      data.directMethods = meths(nd);
      data.virtualMethods = meths(nv);
      const bad = [...data.staticFields, ...data.instanceFields].some((f) => f.idx >= this.fields.length) || [...data.directMethods, ...data.virtualMethods].some((m) => m.idx >= this.methods.length);
      if (bad) throw new DexError('class data member index out of range');
    }
    return (def.data = data);
  }

  private codeItem(off: number): CodeItem {
    const r = new ByteReader(this.src, off);
    const registers = r.u16(), ins = r.u16(), outs = r.u16(), nTries = r.u16(), debugOff = r.u32(), size = r.u32();
    const raw = r.bytes(size * 2);
    const insns = new Uint16Array(size);
    for (let i = 0; i < size; i++) insns[i] = raw[i * 2]! | (raw[i * 2 + 1]! << 8);
    if (nTries && size % 2) r.pos += 2;
    const rawTries = Array.from({ length: nTries }, () => ({ start: r.u32(), count: r.u16(), off: r.u16() }));
    const handlers: CodeHandler[] = [];
    const offToIdx = new Map<number, number>();
    if (nTries) {
      const base = r.pos;
      const n = r.uleb();
      for (let i = 0; i < n; i++) {
        offToIdx.set(r.pos - base, i);
        const sz = r.sleb();
        const catches = Array.from({ length: Math.abs(sz) }, () => ({ type: r.uleb(), addr: r.uleb() }));
        const h: CodeHandler = { catches };
        if (sz <= 0) h.catchAll = r.uleb();
        handlers.push(h);
      }
    }
    const tries: CodeTry[] = rawTries.map((t) => {
      const handler = offToIdx.get(t.off);
      if (handler === undefined) throw new DexError('bad catch handler offset');
      return { start: t.start, count: t.count, handler };
    });
    const item: CodeItem = { registers, ins, outs, insns, tries, handlers, debugOff };
    return item;
  }

  /** Serializes with recomputed layout, map list, checksum and signature. */
  serialize(): Uint8Array {
    return writeDex(this);
  }
}

/** A class definition inside a DexFile, with member queries and edit operations. */
export class DexClass {
  constructor(readonly dex: DexFile, readonly def: ClassDef) {}

  get descriptor(): string { return this.dex.typeName(this.def.type); }
  get accessFlags(): number { return this.def.flags; }
  get superclass(): string | null { return this.def.superclass < 0 ? null : this.dex.typeName(this.def.superclass); }
  get interfaces(): string[] { return this.def.interfaces.map((i) => this.dex.typeName(i)); }

  methods(): MethodInfo[] {
    const d = this.dex, data = d.classData(this.def);
    const info = (m: EncodedMethod, direct: boolean): MethodInfo => {
      const id = d.methods[m.idx]!, p = d.protos[id.proto]!;
      return { idx: m.idx, name: d.text(id.name), params: p.params.map((t) => d.typeName(t)), returnType: d.typeName(p.ret), access: m.flags, direct, hasCode: m.code !== null };
    };
    return [...data.directMethods.map((m) => info(m, true)), ...data.virtualMethods.map((m) => info(m, false))];
  }

  /** Finds a method by name and (optionally) exact signature. */
  findMethod(name: string, params?: string[], returnType?: string): MethodInfo | undefined {
    return this.methods().find((m) => m.name === name && (!params || m.params.join('') === params.join('')) && (returnType === undefined || m.returnType === returnType));
  }

  private entry(m: MethodInfo): EncodedMethod {
    const data = this.dex.classData(this.def);
    const e = (m.direct ? data.directMethods : data.virtualMethods).find((x) => x.idx === m.idx);
    /* c8 ignore next */
    if (!e) throw new DexError('method does not belong to this class');
    return e;
  }

  private assemble(b: CodeBuilder, params: string[], isStatic: boolean): CodeItem {
    const ins = (isStatic ? 0 : 1) + params.reduce((n, p) => n + (p === 'J' || p === 'D' ? 2 : 1), 0);
    return { ...b.build(ins), debugOff: 0 };
  }

  /** Replaces the body of an existing method with newly assembled code (debug info is dropped). */
  replaceBody(m: MethodInfo, code: CodeBuilder): void {
    const e = this.entry(m);
    if (!e.code) throw new DexError(`${m.name} has no code to replace`);
    e.code = this.assemble(code, m.params, !!(m.access & ACC.STATIC));
    this.dex.dirty = true;
  }

  /** The body of a method (undefined for abstract and native methods). The returned object is live: do not mutate it, use `patchInsns` / `prependCode`. */
  codeOf(m: MethodInfo): CodeItem | undefined {
    return this.entry(m).code ?? undefined;
  }

  /** Edits the instructions of a method in place. `fn` may overwrite code units but must not change the length. */
  patchInsns(m: MethodInfo, fn: (insns: Uint16Array) => void): void {
    const code = this.entry(m).code;
    if (!code) throw new DexError(`${m.name} has no code to patch`);
    fn(code.insns);
    this.dex.dirty = true;
  }

  /**
   * Inserts instructions at the very start of an existing method, keeping the original body (try ranges and handler
   * addresses move with it; branch offsets are relative and stay valid). `make(registers, ins)` returns the prefix; it
   * must only use registers below `registers` and may branch to a label at its own end to fall through into the
   * original code. The prefix is padded to an even number of code units so data payloads keep their alignment.
   * Debug info of the method is dropped.
   */
  prependCode(m: MethodInfo, make: (registers: number, ins: number) => CodeBuilder): void {
    const e = this.entry(m);
    if (!e.code) throw new DexError(`${m.name} has no code to extend`);
    const old = e.code;
    const pre = make(old.registers, old.ins).build(old.ins);
    if (pre.tries.length) throw new DexError('a prefix cannot contain try blocks');
    const lead = pre.insns.length + (pre.insns.length % 2);
    const insns = new Uint16Array(lead + old.insns.length);
    insns.set(pre.insns, 0);
    insns.set(old.insns, lead);
    e.code = {
      registers: old.registers, ins: old.ins, outs: Math.max(old.outs, pre.outs), insns, debugOff: 0,
      tries: old.tries.map((t) => ({ ...t, start: t.start + lead })),
      handlers: old.handlers.map((h) => ({ catches: h.catches.map((c) => ({ ...c, addr: c.addr + lead })), ...(h.catchAll === undefined ? {} : { catchAll: h.catchAll + lead }) })),
    };
    this.dex.dirty = true;
  }

  /** Adds a static field without initial value (null / zero) and returns its provisional field_ids index. */
  addStaticField(name: string, type: string, access: number): number {
    const d = this.dex;
    const idx = d.field(this.descriptor, name, type);
    const data = d.classData(this.def);
    if ([...data.staticFields, ...data.instanceFields].some((f) => f.idx === idx)) throw new DexError(`field ${name} already exists in ${this.descriptor}`);
    data.staticFields.push({ idx, flags: access | ACC.STATIC });
    d.dirty = true;
    return idx;
  }

  /** Adds a new method; static/private/constructor methods become direct, the rest virtual. */
  addMethod(spec: MethodSpec): MethodInfo {
    const d = this.dex;
    const abstractOrNative = !!(spec.access & (ACC.ABSTRACT | ACC.NATIVE));
    if (abstractOrNative === !!spec.code) throw new DexError(`${spec.name}: code is required unless the method is abstract or native (and forbidden then)`);
    const idx = d.method(this.descriptor, spec.name, spec.returnType, spec.params);
    const data = d.classData(this.def);
    const direct = !!(spec.access & (ACC.STATIC | ACC.PRIVATE | ACC.CONSTRUCTOR));
    if ([...data.directMethods, ...data.virtualMethods].some((x) => x.idx === idx)) throw new DexError(`method ${spec.name} already exists in ${this.descriptor}`);
    const code = spec.code ? this.assemble(spec.code, spec.params, !!(spec.access & ACC.STATIC)) : null;
    (direct ? data.directMethods : data.virtualMethods).push({ idx, flags: spec.access, code });
    d.dirty = true;
    return { idx, name: spec.name, params: spec.params, returnType: spec.returnType, access: spec.access, direct, hasCode: !!code };
  }
}
