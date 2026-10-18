import { ByteReader, ByteWriter, DexError } from './bytes';
import { adler32, sha1 } from './hash';
import { remapInsns, type IndexMaps } from './insns';
import { utf16Length } from './mutf8';
import { HEADER_SIZE, NO_INDEX } from './consts';
import type { ClassData, CodeItem, DexFile } from './dex';

// ---- index permutations ---------------------------------------------------------------------------------------

interface Maps {
  s: number[]; t: number[]; p: number[]; f: number[]; m: number[];
  sOrder: number[]; tOrder: number[]; pOrder: number[]; fOrder: number[]; mOrder: number[];
}

function permutation(n: number, orig: number, cmp: (a: number, b: number) => number): { order: number[]; map: number[] } {
  const order = Array.from({ length: n }, (_, i) => i);
  if (n !== orig) order.sort(cmp);
  const map = new Array<number>(n);
  order.forEach((p, f) => { map[p] = f; });
  return { order, map };
}

/** Sorts every id table into the order the DEX format requires and returns provisional-to-final index maps. */
function buildMaps(d: DexFile): Maps {
  const o = d.orig;
  const cmpNum = (a: number, b: number): number => a - b;
  const s = permutation(d.strings.length, o.strings, (a, b) => { const x = d.text(a), y = d.text(b); return x < y ? -1 : 1; });
  const t = permutation(d.types.length, o.types, (a, b) => cmpNum(s.map[d.types[a]!]!, s.map[d.types[b]!]!));
  const p = permutation(d.protos.length, o.protos, (a, b) => {
    const x = d.protos[a]!, y = d.protos[b]!;
    const r = cmpNum(t.map[x.ret]!, t.map[y.ret]!);
    if (r) return r;
    for (let i = 0; i < Math.min(x.params.length, y.params.length); i++) {
      const c = cmpNum(t.map[x.params[i]!]!, t.map[y.params[i]!]!);
      if (c) return c;
    }
    return cmpNum(x.params.length, y.params.length);
  });
  const f = permutation(d.fields.length, o.fields, (a, b) => {
    const x = d.fields[a]!, y = d.fields[b]!;
    return cmpNum(t.map[x.cls]!, t.map[y.cls]!) || cmpNum(s.map[x.name]!, s.map[y.name]!) || cmpNum(t.map[x.type]!, t.map[y.type]!);
  });
  const m = permutation(d.methods.length, o.methods, (a, b) => {
    const x = d.methods[a]!, y = d.methods[b]!;
    return cmpNum(t.map[x.cls]!, t.map[y.cls]!) || cmpNum(s.map[x.name]!, s.map[y.name]!) || cmpNum(p.map[x.proto]!, p.map[y.proto]!);
  });
  return { s: s.map, t: t.map, p: p.map, f: f.map, m: m.map, sOrder: s.order, tOrder: t.order, pOrder: p.order, fOrder: f.order, mOrder: m.order };
}

// ---- items ----------------------------------------------------------------------------------------------------

interface Ctx {
  d: DexFile;
  m: Maps;
  maps: IndexMaps;
  /** Offset of an item as assigned by the previous layout pass (0 for none). */
  off(item: Item | null | undefined): number;
}
interface Item {
  sec: number;
  align: number;
  emit(w: ByteWriter, c: Ctx): void;
}

const SEC = { TYPE_LIST: 0x1001, REF_LIST: 0x1002, SET: 0x1003, CLASS_DATA: 0x2000, CODE: 0x2001, STRING: 0x2002, DEBUG: 0x2003, ANNOTATION: 0x2004, ARRAY: 0x2005, DIR: 0x2006 } as const;

function lookup(a: number[], i: number, what: string): number {
  const v = a[i];
  if (v === undefined) throw new DexError(`${what} index ${i} out of range`);
  return v;
}

function u16Index(v: number, what: string): number {
  if (v > 0xffff) throw new DexError(`too many ${what} for a single dex (index ${v} needs more than 16 bits)`);
  return v;
}

/** Copies one encoded_value, remapping constant-pool indices. */
function copyValue(r: ByteReader, w: ByteWriter, c: Ctx): void {
  const head = r.u8();
  const type = head & 0x1f, arg = head >> 5;
  switch (type) {
    case 0x15: case 0x17: case 0x18: case 0x19: case 0x1a: case 0x1b: {
      let v = 0;
      for (let i = 0; i <= arg; i++) v += r.u8() * 2 ** (8 * i);
      const nv = type === 0x15 ? c.maps.proto(v) : type === 0x17 ? c.maps.string(v) : type === 0x18 ? c.maps.type(v) : type === 0x1a ? c.maps.method(v) : c.maps.field(v);
      let size = 1;
      while (nv >= 2 ** (8 * size)) size++;
      w.u8(type | ((size - 1) << 5));
      for (let i = 0; i < size; i++) w.u8(Math.floor(nv / 2 ** (8 * i)) & 0xff);
      return;
    }
    case 0x1c: {
      w.u8(head);
      const n = r.uleb();
      w.uleb(n);
      for (let i = 0; i < n; i++) copyValue(r, w, c);
      return;
    }
    case 0x1d: w.u8(head); copyAnnotation(r, w, c); return;
    case 0x1e: case 0x1f: w.u8(head); return;
    default: {
      /* byte, short, char, int, long, float, double, method handle: copy payload */
      if (![0, 2, 3, 4, 6, 0x10, 0x11, 0x16].includes(type)) throw new DexError(`bad encoded value type 0x${type.toString(16)}`);
      w.u8(head);
      w.bytes(r.bytes(arg + 1));
    }
  }
}

function copyAnnotation(r: ByteReader, w: ByteWriter, c: Ctx): void {
  w.uleb(c.maps.type(r.uleb()));
  const n = r.uleb();
  w.uleb(n);
  for (let i = 0; i < n; i++) {
    w.uleb(c.maps.string(r.uleb()));
    copyValue(r, w, c);
  }
}

function copyDebug(r: ByteReader, w: ByteWriter, c: Ctx): void {
  w.uleb(r.uleb());
  const n = r.uleb();
  w.uleb(n);
  const str = (): void => { const v = r.ulebP1(); w.ulebP1(v < 0 ? -1 : c.maps.string(v)); };
  const typ = (): void => { const v = r.ulebP1(); w.ulebP1(v < 0 ? -1 : c.maps.type(v)); };
  for (let i = 0; i < n; i++) str();
  for (;;) {
    const op = r.u8();
    w.u8(op);
    if (op === 0) return;
    if (op === 1) w.uleb(r.uleb());
    else if (op === 2) w.sleb(r.sleb());
    else if (op === 3 || op === 4) { w.uleb(r.uleb()); str(); typ(); if (op === 4) str(); }
    else if (op === 5 || op === 6) w.uleb(r.uleb());
    else if (op === 9) str();
  }
}

class TypeListItem implements Item {
  sec: number = SEC.TYPE_LIST; align = 4;
  constructor(readonly types: number[]) {}
  emit(w: ByteWriter, c: Ctx): void {
    w.u32(this.types.length);
    for (const t of this.types) w.u16(u16Index(lookup(c.m.t, t, 'type'), 'types'));
  }
}
class SetItem implements Item {
  sec: number = SEC.SET; align = 4;
  constructor(readonly items: Item[]) {}
  emit(w: ByteWriter, c: Ctx): void {
    w.u32(this.items.length);
    for (const i of this.items) w.u32(c.off(i));
  }
}
class RefListItem implements Item {
  sec: number = SEC.REF_LIST; align = 4;
  constructor(readonly sets: (SetItem | null)[]) {}
  emit(w: ByteWriter, c: Ctx): void {
    w.u32(this.sets.length);
    for (const s of this.sets) w.u32(c.off(s));
  }
}
/** Debug info, annotation and encoded array items: no offsets inside, only indices to remap while copying. */
class LeafItem implements Item {
  align = 1;
  constructor(readonly sec: number, readonly srcOff: number) {}
  emit(w: ByteWriter, c: Ctx): void {
    const r = new ByteReader(c.d.src, this.srcOff);
    if (this.sec === SEC.DEBUG) copyDebug(r, w, c);
    else if (this.sec === SEC.ANNOTATION) { w.u8(r.u8()); copyAnnotation(r, w, c); }
    else { const n = r.uleb(); w.uleb(n); for (let i = 0; i < n; i++) copyValue(r, w, c); }
  }
}
class StringItem implements Item {
  sec: number = SEC.STRING; align = 1;
  constructor(readonly bytes: Uint8Array) {}
  emit(w: ByteWriter): void { w.uleb(utf16Length(this.bytes)); w.bytes(this.bytes); w.u8(0); }
}
class CodeItemItem implements Item {
  sec: number = SEC.CODE; align = 4;
  constructor(readonly code: CodeItem, readonly debug: Item | null) {}
  emit(w: ByteWriter, c: Ctx): void {
    const k = this.code;
    w.u16(k.registers); w.u16(k.ins); w.u16(k.outs); w.u16(k.tries.length);
    w.u32(c.off(this.debug));
    w.u32(k.insns.length);
    for (const u of remapInsns(k.insns, c.maps)) w.u16(u);
    if (!k.tries.length) return;
    if (k.insns.length % 2) w.u16(0);
    const hw = new ByteWriter();
    hw.uleb(k.handlers.length);
    const offs = k.handlers.map((h) => {
      const at = hw.len;
      hw.sleb(h.catchAll === undefined ? h.catches.length : -h.catches.length);
      for (const cc of h.catches) { hw.uleb(c.maps.type(cc.type)); hw.uleb(cc.addr); }
      if (h.catchAll !== undefined) hw.uleb(h.catchAll);
      return at;
    });
    for (const t of k.tries) {
      w.u32(t.start); w.u16(t.count);
      w.u16(lookup(offs, t.handler, 'handler'));
    }
    w.bytes(hw.result());
  }
}
class ClassDataItem implements Item {
  sec: number = SEC.CLASS_DATA; align = 1;
  constructor(readonly data: ClassData, readonly codeItems: Map<CodeItem, Item>) {}
  emit(w: ByteWriter, c: Ctx): void {
    const dt = this.data;
    w.uleb(dt.staticFields.length); w.uleb(dt.instanceFields.length); w.uleb(dt.directMethods.length); w.uleb(dt.virtualMethods.length);
    const fields = (list: ClassData['staticFields']): void => {
      let prev = 0;
      for (const f of list.map((x) => ({ ...x, idx: lookup(c.m.f, x.idx, 'field') })).sort((a, b) => a.idx - b.idx)) { w.uleb(f.idx - prev); prev = f.idx; w.uleb(f.flags); }
    };
    const meths = (list: ClassData['directMethods']): void => {
      let prev = 0;
      for (const mm of list.map((x) => ({ ...x, idx: lookup(c.m.m, x.idx, 'method') })).sort((a, b) => a.idx - b.idx)) {
        w.uleb(mm.idx - prev); prev = mm.idx; w.uleb(mm.flags); w.uleb(mm.code ? c.off(this.codeItems.get(mm.code)) : 0);
      }
    };
    fields(dt.staticFields); fields(dt.instanceFields); meths(dt.directMethods); meths(dt.virtualMethods);
  }
}
class DirItem implements Item {
  sec: number = SEC.DIR; align = 4;
  constructor(readonly cls: Item | null, readonly fields: { idx: number; item: Item | null }[], readonly methods: { idx: number; item: Item | null }[], readonly params: { idx: number; item: Item | null }[]) {}
  emit(w: ByteWriter, c: Ctx): void {
    w.u32(c.off(this.cls)); w.u32(this.fields.length); w.u32(this.methods.length); w.u32(this.params.length);
    const part = (list: DirItem['fields'], map: number[], what: string): void => {
      for (const e of list.map((x) => ({ idx: lookup(map, x.idx, what), item: x.item })).sort((a, b) => a.idx - b.idx)) { w.u32(e.idx); w.u32(c.off(e.item)); }
    };
    part(this.fields, c.m.f, 'field'); part(this.methods, c.m.m, 'method'); part(this.params, c.m.m, 'method');
  }
}

// ---- item graph collection --------------------------------------------------------------------------------------

class Pools {
  readonly lists = new Map<number, Item[]>();
  private memo = new Map<unknown, Item>();
  get<T extends Item>(key: unknown, make: () => T): T {
    const hit = this.memo.get(key);
    if (hit) return hit as T;
    const it = make();
    this.memo.set(key, it);
    this.list(it.sec).push(it);
    return it;
  }
  list(sec: number): Item[] {
    let l = this.lists.get(sec);
    if (!l) this.lists.set(sec, (l = []));
    return l;
  }
}

interface Graph {
  pools: Pools;
  stringItems: Item[]; // by final string index
  protoLists: (Item | null)[]; // by provisional proto index
  classLists: (Item | null)[]; // interface lists, by class def order
  classData: (Item | null)[];
  classDirs: (Item | null)[];
  classValues: (Item | null)[];
}

function collect(d: DexFile, m: Maps): Graph {
  const pools = new Pools();
  const src = d.src;
  const typeList = (types: number[]): Item | null => (types.length ? pools.get(`tl:${types.join(',')}`, () => new TypeListItem(types)) : null);
  const leaf = (sec: number, off: number): Item => pools.get(`${sec}:${off}`, () => new LeafItem(sec, off));
  const stringItems: Item[] = m.sOrder.map((p) => pools.get(d.strings[p]!, () => new StringItem(d.strings[p]!.bytes)));
  const protoLists = d.protos.map((p) => typeList(p.params));
  const codeItems = new Map<CodeItem, Item>();

  const set = (off: number): SetItem | null => {
    if (!off) return null;
    return pools.get(`set:${off}`, () => {
      const r = new ByteReader(src, off);
      const n = r.u32();
      const items: Item[] = [];
      for (let i = 0; i < n; i++) items.push(leaf(SEC.ANNOTATION, r.u32()));
      return new SetItem(items);
    });
  };
  const refList = (off: number): Item => pools.get(`rl:${off}`, () => {
    const r = new ByteReader(src, off);
    const n = r.u32();
    const sets: (SetItem | null)[] = [];
    for (let i = 0; i < n; i++) sets.push(set(r.u32()));
    return new RefListItem(sets);
  });
  const dir = (off: number): Item => pools.get(`dir:${off}`, () => {
    const r = new ByteReader(src, off);
    const co = r.u32(), nf = r.u32(), nm = r.u32(), np = r.u32();
    const cls = set(co);
    const read = <T>(n: number, f: (off: number) => T): { idx: number; item: T }[] => Array.from({ length: n }, () => ({ idx: r.u32(), item: f(r.u32()) }));
    return new DirItem(cls, read(nf, set), read(nm, set), read(np, refList));
  });

  const classLists: (Item | null)[] = [], classData: (Item | null)[] = [], classDirs: (Item | null)[] = [], classValues: (Item | null)[] = [];
  for (const def of d.classDefs) {
    classLists.push(typeList(def.interfaces));
    classDirs.push(def.annotationsOff ? dir(def.annotationsOff) : null);
    classValues.push(def.staticValuesOff ? leaf(SEC.ARRAY, def.staticValuesOff) : null);
    const data = d.classData(def);
    if (!data.staticFields.length && !data.instanceFields.length && !data.directMethods.length && !data.virtualMethods.length) { classData.push(null); continue; }
    for (const mm of [...data.directMethods, ...data.virtualMethods]) {
      const code = mm.code;
      if (code && !codeItems.has(code)) codeItems.set(code, pools.get(code, () => new CodeItemItem(code, code.debugOff ? leaf(SEC.DEBUG, code.debugOff) : null)));
    }
    classData.push(pools.get(data, () => new ClassDataItem(data, codeItems)));
  }
  return { pools, stringItems, protoLists, classLists, classData, classDirs, classValues };
}

// ---- emission ---------------------------------------------------------------------------------------------------

interface Layout { off: Map<Item, number>; size: number }

const DATA_ORDER = [SEC.TYPE_LIST, SEC.REF_LIST, SEC.SET, SEC.CLASS_DATA, SEC.CODE, SEC.STRING, SEC.DEBUG, SEC.ANNOTATION, SEC.ARRAY, SEC.DIR];

function emitPass(d: DexFile, m: Maps, g: Graph, prev: Layout): { bytes: Uint8Array; layout: Layout } {
  const bound = (a: number[], i: number, what: string): number => lookup(a, i, what);
  const maps: IndexMaps = {
    string: (i) => bound(m.s, i, 'string'), type: (i) => bound(m.t, i, 'type'), field: (i) => bound(m.f, i, 'field'),
    method: (i) => bound(m.m, i, 'method'), proto: (i) => bound(m.p, i, 'proto'),
  };
  const ctx: Ctx = { d, m, maps, off: (it) => (it ? prev.off.get(it) ?? 0 : 0) };
  const w = new ByteWriter();
  w.bytes(new Uint8Array(HEADER_SIZE));
  const off = new Map<Item, number>();

  const table = (n: number): number => (n ? w.len : 0);
  const stringIdsOff = table(m.sOrder.length);
  g.stringItems.forEach((it) => w.u32(ctx.off(it)));
  const typeIdsOff = table(m.tOrder.length);
  for (const p of m.tOrder) w.u32(m.s[d.types[p]!]!);
  const protoIdsOff = table(m.pOrder.length);
  for (const p of m.pOrder) {
    const pr = d.protos[p]!;
    w.u32(m.s[pr.shorty]!); w.u32(m.t[pr.ret]!); w.u32(ctx.off(g.protoLists[p]));
  }
  const fieldIdsOff = table(m.fOrder.length);
  for (const p of m.fOrder) {
    const f = d.fields[p]!;
    w.u16(u16Index(m.t[f.cls]!, 'types')); w.u16(u16Index(m.t[f.type]!, 'types')); w.u32(m.s[f.name]!);
  }
  const methodIdsOff = table(m.mOrder.length);
  for (const p of m.mOrder) {
    const mm = d.methods[p]!;
    w.u16(u16Index(m.t[mm.cls]!, 'types')); w.u16(u16Index(m.p[mm.proto]!, 'protos')); w.u32(m.s[mm.name]!);
  }
  const classDefsOff = table(d.classDefs.length);
  d.classDefs.forEach((c, i) => {
    w.u32(m.t[c.type]!); w.u32(c.flags); w.u32(c.superclass < 0 ? NO_INDEX : m.t[c.superclass]!);
    w.u32(ctx.off(g.classLists[i])); w.u32(c.sourceFile < 0 ? NO_INDEX : m.s[c.sourceFile]!);
    w.u32(ctx.off(g.classDirs[i])); w.u32(ctx.off(g.classData[i])); w.u32(ctx.off(g.classValues[i]));
  });
  const dataOff = w.len;

  const sections: { type: number; count: number; off: number }[] = [{ type: 0, count: 1, off: 0 }];
  const idSec = (type: number, count: number, o: number): void => { if (count) sections.push({ type, count, off: o }); };
  idSec(1, m.sOrder.length, stringIdsOff); idSec(2, m.tOrder.length, typeIdsOff); idSec(3, m.pOrder.length, protoIdsOff);
  idSec(4, m.fOrder.length, fieldIdsOff); idSec(5, m.mOrder.length, methodIdsOff); idSec(6, d.classDefs.length, classDefsOff);
  const nonEmpty = DATA_ORDER.filter((s) => g.pools.list(s).length);
  const mapSize = 4 + 12 * (sections.length + nonEmpty.length + 1);
  const mapOff = w.len;
  w.bytes(new Uint8Array(mapSize));
  sections.push({ type: 0x1000, count: 1, off: mapOff });
  for (const sec of nonEmpty) {
    const list = g.pools.list(sec);
    w.align(list[0]!.align);
    sections.push({ type: sec, count: list.length, off: w.len });
    for (const it of list) {
      w.align(it.align);
      off.set(it, w.len);
      it.emit(w, ctx);
    }
  }
  const dv = new DataView(w.buf.buffer);
  dv.setUint32(mapOff, sections.length, true);
  sections.forEach((s, i) => {
    dv.setUint16(mapOff + 4 + i * 12, s.type, true); dv.setUint16(mapOff + 6 + i * 12, 0, true);
    dv.setUint32(mapOff + 8 + i * 12, s.count, true); dv.setUint32(mapOff + 12 + i * 12, s.off, true);
  });

  const h = (at: number, v: number): void => dv.setUint32(at, v >>> 0, true);
  w.buf.set([0x64, 0x65, 0x78, 0x0a, ...d.version.split('').map((ch) => ch.charCodeAt(0)), 0]);
  h(0x20, w.len); h(0x24, HEADER_SIZE); h(0x28, 0x12345678); h(0x34, mapOff);
  h(0x38, m.sOrder.length); h(0x3c, stringIdsOff); h(0x40, m.tOrder.length); h(0x44, typeIdsOff);
  h(0x48, m.pOrder.length); h(0x4c, protoIdsOff); h(0x50, m.fOrder.length); h(0x54, fieldIdsOff);
  h(0x58, m.mOrder.length); h(0x5c, methodIdsOff); h(0x60, d.classDefs.length); h(0x64, classDefsOff);
  h(0x68, w.len - dataOff); h(0x6c, dataOff);
  return { bytes: w.result(), layout: { off, size: w.len } };
}

function sameLayout(a: Layout, b: Layout): boolean {
  return a.size === b.size && [...a.off].every(([k, v]) => b.off.get(k) === v);
}

/** Serializes the model: sorts id tables, remaps all indices, lays out data, then writes map list, checksum and signature. */
export function writeDex(d: DexFile): Uint8Array {
  const m = buildMaps(d);
  const g = collect(d, m);
  let prev: Layout = { off: new Map(), size: 0 };
  let cur = emitPass(d, m, g, prev);
  for (let pass = 0; !sameLayout(cur.layout, prev); pass++) {
    /* v8 ignore next */
    if (pass >= 8) throw new DexError('dex layout did not converge');
    prev = cur.layout;
    cur = emitPass(d, m, g, prev);
  }
  const bytes = cur.bytes;
  bytes.set(sha1(bytes.subarray(32)), 12);
  new DataView(bytes.buffer).setUint32(8, adler32(bytes.subarray(12)), true);
  return bytes;
}
