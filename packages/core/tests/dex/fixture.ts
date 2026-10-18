/**
 * Independent, test-only DEX writer: turns a declarative spec into a valid dex (sorted ids, all item kinds).
 * It shares no code with src/dex, so round-trip tests compare two separate implementations.
 */
import { createHash } from 'node:crypto';

export type Ref = { s: string } | { t: string } | { f: [string, string, string] } | { m: [string, string, string, string[]] } | { p: [string, string[]] };
export type Unit = number | (Ref & { wide?: boolean });

export type Val =
  | { k: 'byte' | 'short' | 'char' | 'int' | 'long'; v: number | bigint }
  | { k: 'float' | 'double'; raw: number[] }
  | { k: 'string' | 'type' | 'enum' | 'field' | 'method' | 'proto'; ref: Ref }
  | { k: 'array'; v: Val[] }
  | { k: 'annotation'; a: AnnSpec }
  | { k: 'null' }
  | { k: 'bool'; v: boolean }
  | { k: 'handle'; idx: number };
export interface AnnSpec { type: string; elems: [string, Val][] }
export type Ann = { vis: number; a: AnnSpec };

export type DebugOp =
  | ['startLocal', number, string | null, string | null] | ['startLocalExt', number, string | null, string | null, string | null]
  | ['endLocal', number] | ['restart', number] | ['prologue'] | ['epilogue'] | ['setFile', string | null]
  | ['advancePc', number] | ['advanceLine', number] | ['special', number];
export interface DebugSpec { line: number; params: (string | null)[]; ops: DebugOp[] }
export interface CodeSpec {
  regs: number; ins: number; outs: number; insns: Unit[];
  tries?: { start: number; count: number; handler: number }[];
  handlers?: { catches: { type: string; addr: number }[]; catchAll?: number }[];
  debug?: DebugSpec;
}
export interface MSpec { name: string; ret: string; params: string[]; flags: number; code?: CodeSpec }
export interface FSpec { name: string; type: string; flags: number }
export interface ClsSpec {
  name: string; flags?: number; super?: string | null; ifaces?: string[]; source?: string;
  sfields?: FSpec[]; ifields?: FSpec[]; direct?: MSpec[]; virtual?: MSpec[];
  ann?: { cls?: Ann[]; fields?: Record<string, Ann[]>; methods?: Record<string, Ann[]>; params?: Record<string, Ann[][]> };
  values?: Val[];
}
export interface DexSpec { classes: ClsSpec[]; version?: string; extraStrings?: string[] }

const shortyOf = (t: string): string => (t[0] === '[' ? 'L' : t[0]!);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const mutf8 = (s: string): number[] => {
  const o: number[] = [];
  for (const ch of s) {
    const units = ch.codePointAt(0)! > 0xffff ? [0xd800 + ((ch.codePointAt(0)! - 0x10000) >> 10), 0xdc00 + ((ch.codePointAt(0)! - 0x10000) & 0x3ff)] : [ch.codePointAt(0)!];
    for (const c of units) {
      if (c !== 0 && c < 0x80) o.push(c);
      else if (c < 0x800) o.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else o.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return o;
};
class W {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 255); }
  u16(v: number) { this.u8(v); this.u8(v >> 8); }
  u32(v: number) { this.u16(v & 0xffff); this.u16(Math.floor(v / 65536) & 0xffff); }
  uleb(v: number) { do { let x = v % 128; v = Math.floor(v / 128); if (v) x |= 128; this.u8(x); } while (v); }
  sleb(v: number) { for (;;) { const x = ((v % 128) + 128) % 128; v = Math.floor(v / 128); const done = (v === 0 && !(x & 64)) || (v === -1 && !!(x & 64)); this.u8(done ? x : x | 128); if (done) return; } }
  align(n: number) { while (this.b.length % n) this.u8(0); }
  get len() { return this.b.length; }
}

export function buildDex(spec: DexSpec): Uint8Array {
  // ---- gather constants
  const strs = new Set<string>(spec.extraStrings ?? []);
  const types = new Set<string>();
  const protos = new Map<string, [string, string[]]>();
  const fields = new Map<string, [string, string, string]>();
  const meths = new Map<string, [string, string, string, string[]]>();
  const S = (s: string) => { strs.add(s); return s; };
  const T = (t: string) => { types.add(t); S(t); return t; };
  const P = (ret: string, ps: string[]) => { T(ret); ps.forEach(T); const sh = [ret, ...ps].map(shortyOf).join(''); S(sh); protos.set(`${ret}(${ps.join('')})`, [ret, ps]); return `${ret}(${ps.join('')})`; };
  const F = (c: string, n: string, t: string) => { T(c); T(t); S(n); fields.set(`${c}.${n}:${t}`, [c, n, t]); return `${c}.${n}:${t}`; };
  const M = (c: string, n: string, r: string, ps: string[]) => { T(c); S(n); P(r, ps); meths.set(`${c}.${n}${r}(${ps.join('')})`, [c, n, r, ps]); return `${c}.${n}${r}(${ps.join('')})`; };
  const touchRef = (r: Ref) => { if ('s' in r) S(r.s); else if ('t' in r) T(r.t); else if ('f' in r) F(...r.f); else if ('m' in r) M(...r.m); else P(...r.p); };
  const touchVal = (v: Val): void => {
    if ('ref' in v) touchRef(v.ref); else if (v.k === 'array') v.v.forEach(touchVal); else if (v.k === 'annotation') touchAnn(v.a);
  };
  const touchAnn = (a: AnnSpec) => { T(a.type); a.elems.forEach(([n, v]) => { S(n); touchVal(v); }); };
  for (const c of spec.classes) {
    T(c.name); if (c.super) T(c.super); c.ifaces?.forEach(T); if (c.source) S(c.source);
    for (const f of [...(c.sfields ?? []), ...(c.ifields ?? [])]) F(c.name, f.name, f.type);
    for (const m of [...(c.direct ?? []), ...(c.virtual ?? [])]) {
      M(c.name, m.name, m.ret, m.params);
      for (const u of m.code?.insns ?? []) if (typeof u !== 'number') touchRef(u);
      m.code?.handlers?.forEach((h) => h.catches.forEach((x) => T(x.type)));
      const d = m.code?.debug;
      if (d) { d.params.forEach((p) => p && S(p)); d.ops.forEach((o) => o.slice(2).forEach((x) => typeof x === 'string' && S(x))); d.ops.forEach((o) => { if (o[0] === 'setFile' && o[1]) S(o[1]); }); }
    }
    const anns = [...(c.ann?.cls ?? []), ...Object.values(c.ann?.fields ?? {}).flat(), ...Object.values(c.ann?.methods ?? {}).flat(), ...Object.values(c.ann?.params ?? {}).flat(2)];
    anns.forEach((a) => touchAnn(a.a));
    for (const k of Object.keys(c.ann?.fields ?? {})) F(c.name, k.split(':')[0]!, k.split(':')[1]!);
    c.values?.forEach(touchVal);
  }
  const strList = [...strs].sort(cmp);
  const sIdx = new Map(strList.map((s, i) => [s, i]));
  const typeList = [...types].sort((a, b) => sIdx.get(a)! - sIdx.get(b)!);
  const tIdx = new Map(typeList.map((s, i) => [s, i]));
  const cmpArr = (a: number[], b: number[]) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return a.length - b.length; };
  const protoList = [...protos.entries()].sort(([, a], [, b]) => tIdx.get(a[0])! - tIdx.get(b[0])! || cmpArr(a[1].map((t) => tIdx.get(t)!), b[1].map((t) => tIdx.get(t)!)));
  const pIdx = new Map(protoList.map(([k], i) => [k, i]));
  const fieldList = [...fields.entries()].sort(([, a], [, b]) => tIdx.get(a[0])! - tIdx.get(b[0])! || sIdx.get(a[1])! - sIdx.get(b[1])! || tIdx.get(a[2])! - tIdx.get(b[2])!);
  const fIdx = new Map(fieldList.map(([k], i) => [k, i]));
  const methList = [...meths.entries()].sort(([, a], [, b]) => tIdx.get(a[0])! - tIdx.get(b[0])! || sIdx.get(a[1])! - sIdx.get(b[1])! || pIdx.get(`${a[2]}(${a[3].join('')})`)! - pIdx.get(`${b[2]}(${b[3].join('')})`)!);
  const mIdx = new Map(methList.map(([k], i) => [k, i]));
  const refIdx = (r: Ref): number => ('s' in r ? sIdx.get(r.s)! : 't' in r ? tIdx.get(r.t)! : 'f' in r ? fIdx.get(`${r.f[0]}.${r.f[1]}:${r.f[2]}`)! : 'm' in r ? mIdx.get(`${r.m[0]}.${r.m[1]}${r.m[2]}(${r.m[3].join('')})`)! : pIdx.get(`${r.p[0]}(${r.p[1].join('')})`)!);

  // ---- id tables size -> data offset
  const classes = spec.classes;
  const idsEnd = 0x70 + strList.length * 4 + typeList.length * 4 + protoList.length * 12 + fieldList.length * 8 + methList.length * 8 + classes.length * 32;
  const data = new W();
  const abs = () => idsEnd + data.len;
  const put = (w: W, align = 1): number => { data.align(align); const o = abs(); data.b.push(...w.b); return o; };
  const mapItems: [number, number, number][] = [];
  const noteMap = (type: number, count: number, off: number) => { if (count) mapItems.push([type, count, off]); };

  // string data
  const strOffs: number[] = [];
  const strStart = abs();
  for (const s of strList) {
    const w = new W(); const bytes = mutf8(s); const ulen = [...s].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
    w.uleb(ulen); bytes.forEach((x) => w.u8(x)); w.u8(0);
    strOffs.push(put(w));
  }
  noteMap(0x2002, strList.length, strStart);

  const encVal = (w: W, v: Val): void => {

    const num = (type: number, x: number | bigint) => {
      let big = BigInt(x);
      const bytes: number[] = [];
      do { bytes.push(Number(big & 0xffn)); big >>= 8n; } while (big > 0n);
      w.u8(type | ((bytes.length - 1) << 5)); bytes.forEach((b) => w.u8(b));
    };
    switch (v.k) {
      case 'byte': w.u8(0x00); w.u8(Number(v.v)); break;
      case 'short': num(0x02, v.v); break;
      case 'char': num(0x03, v.v); break;
      case 'int': num(0x04, v.v); break;
      case 'long': num(0x06, v.v); break;
      case 'float': w.u8(0x10 | ((v.raw.length - 1) << 5)); v.raw.forEach((b) => w.u8(b)); break;
      case 'double': w.u8(0x11 | ((v.raw.length - 1) << 5)); v.raw.forEach((b) => w.u8(b)); break;
      case 'proto': num(0x15, refIdx(v.ref)); break;
      case 'handle': num(0x16, v.idx); break;
      case 'string': num(0x17, refIdx(v.ref)); break;
      case 'type': num(0x18, refIdx(v.ref)); break;
      case 'field': num(0x19, refIdx(v.ref)); break;
      case 'method': num(0x1a, refIdx(v.ref)); break;
      case 'enum': num(0x1b, refIdx(v.ref)); break;
      case 'array': w.u8(0x1c); w.uleb(v.v.length); v.v.forEach((x) => encVal(w, x)); break;
      case 'annotation': w.u8(0x1d); encAnn(w, v.a); break;
      case 'null': w.u8(0x1e); break;
      case 'bool': w.u8(0x1f | ((v.v ? 1 : 0) << 5)); break;
    }
  };
  const encAnn = (w: W, a: AnnSpec): void => {
    w.uleb(tIdx.get(a.type)!); w.uleb(a.elems.length);
    [...a.elems].sort(([x], [y]) => sIdx.get(x)! - sIdx.get(y)!).forEach(([n, v]) => { w.uleb(sIdx.get(n)!); encVal(w, v); });
  };

  // type lists
  const tlCache = new Map<string, number>();
  const typeListOff = (ts: string[]): number => {
    if (!ts.length) return 0;
    const key = ts.join(',');
    if (!tlCache.has(key)) { const w = new W(); w.u32(ts.length); ts.forEach((t) => w.u16(tIdx.get(t)!)); tlCache.set(key, put(w, 4)); }
    return tlCache.get(key)!;
  };
  const protoOffs = protoList.map(([, [, ps]]) => typeListOff(ps));
  const ifaceOffs = classes.map((c) => typeListOff(c.ifaces ?? []));

  // annotations
  const annOff = (a: Ann): number => { const w = new W(); w.u8(a.vis); encAnn(w, a.a); return put(w); };
  const setOff = (anns: Ann[]): number => {
    const offs = anns.map(annOff).sort((x, y) => x - y);
    const w = new W(); w.u32(offs.length); offs.forEach((o) => w.u32(o));
    return put(w, 4);
  };
  const dirOffs = classes.map((c) => {
    const a = c.ann;
    if (!a) return 0;
    const clsSet = a.cls ? setOff(a.cls) : 0;
    const fe = Object.entries(a.fields ?? {}).map(([k, v]) => [fIdx.get(`${c.name}.${k.split(':')[0]}:${k.split(':')[1]}`)!, setOff(v)] as const).sort((x, y) => x[0] - y[0]);
    const mkey = (k: string) => { const m = [...(c.direct ?? []), ...(c.virtual ?? [])].find((x) => x.name === k)!; return mIdx.get(`${c.name}.${m.name}${m.ret}(${m.params.join('')})`)!; };
    const me = Object.entries(a.methods ?? {}).map(([k, v]) => [mkey(k), setOff(v)] as const).sort((x, y) => x[0] - y[0]);
    const pe = Object.entries(a.params ?? {}).map(([k, v]) => {
      const sets = v.map((x) => (x.length ? setOff(x) : 0));
      const w = new W(); w.u32(sets.length); sets.forEach((s) => w.u32(s));
      return [mkey(k), put(w, 4)] as const;
    }).sort((x, y) => x[0] - y[0]);
    const w = new W();
    w.u32(clsSet); w.u32(fe.length); w.u32(me.length); w.u32(pe.length);
    [...fe, ...me, ...pe].forEach(([i, o]) => { w.u32(i); w.u32(o); });
    return put(w, 4);
  });
  const valueOffs = classes.map((c) => {
    if (!c.values) return 0;
    const w = new W(); w.uleb(c.values.length); c.values.forEach((v) => encVal(w, v));
    return put(w);
  });

  // code + class data
  const encDebug = (d: DebugSpec): number => {
    const w = new W();
    w.uleb(d.line); w.uleb(d.params.length);
    const s1 = (x: string | null) => w.uleb(x === null ? 0 : sIdx.get(x)! + 1);
    const t1 = (x: string | null) => w.uleb(x === null ? 0 : tIdx.get(x)! + 1);
    d.params.forEach(s1);
    for (const o of d.ops) {
      switch (o[0]) {
        case 'startLocal': w.u8(3); w.uleb(o[1]); s1(o[2]); t1(o[3]); break;
        case 'startLocalExt': w.u8(4); w.uleb(o[1]); s1(o[2]); t1(o[3]); s1(o[4]); break;
        case 'endLocal': w.u8(5); w.uleb(o[1]); break;
        case 'restart': w.u8(6); w.uleb(o[1]); break;
        case 'prologue': w.u8(7); break;
        case 'epilogue': w.u8(8); break;
        case 'setFile': w.u8(9); s1(o[1]); break;
        case 'advancePc': w.u8(1); w.uleb(o[1]); break;
        case 'advanceLine': w.u8(2); w.sleb(o[1]); break;
        case 'special': w.u8(o[1]); break;
      }
    }
    w.u8(0);
    return put(w);
  };
  const codeOff = (c: CodeSpec): number => {
    const dbg = c.debug ? encDebug(c.debug) : 0;
    const w = new W();
    const units = c.insns.flatMap((u) => (typeof u === 'number' ? [u] : 'wide' in u && u.wide ? [refIdx(u) & 0xffff, refIdx(u) >>> 16] : [refIdx(u)]));
    w.u16(c.regs); w.u16(c.ins); w.u16(c.outs); w.u16(c.tries?.length ?? 0); w.u32(dbg); w.u32(units.length);
    units.forEach((u) => w.u16(u));
    if (c.tries?.length) {
      if (units.length % 2) w.u16(0);
      const hw = new W();
      hw.uleb(c.handlers!.length);
      const hoffs = c.handlers!.map((h) => {
        const at = hw.len;
        hw.sleb(h.catchAll === undefined ? h.catches.length : -h.catches.length);
        h.catches.forEach((x) => { hw.uleb(tIdx.get(x.type)!); hw.uleb(x.addr); });
        if (h.catchAll !== undefined) hw.uleb(h.catchAll);
        return at;
      });
      c.tries.forEach((t) => { w.u32(t.start); w.u16(t.count); w.u16(hoffs[t.handler]!); });
      hw.b.forEach((x) => w.u8(x));
    }
    return put(w, 4);
  };
  const classDataOffs = classes.map((c) => {
    const lists = [c.sfields ?? [], c.ifields ?? []];
    const ml = [c.direct ?? [], c.virtual ?? []];
    if (lists.every((l) => !l.length) && ml.every((l) => !l.length)) return 0;
    const fe = lists.map((l) => l.map((f) => [fIdx.get(`${c.name}.${f.name}:${f.type}`)!, f.flags] as const).sort((a, b) => a[0] - b[0]));
    const me = ml.map((l) => l.map((m) => [mIdx.get(`${c.name}.${m.name}${m.ret}(${m.params.join('')})`)!, m.flags, m.code ? codeOff(m.code) : 0] as const).sort((a, b) => a[0] - b[0]));
    const w = new W();
    [...fe, ...me].forEach((l) => w.uleb(l.length));
    fe.forEach((l) => { let p = 0; l.forEach(([i, f]) => { w.uleb(i - p); p = i; w.uleb(f); }); });
    me.forEach((l) => { let p = 0; l.forEach(([i, f, co]) => { w.uleb(i - p); p = i; w.uleb(f); w.uleb(co); }); });
    return put(w);
  });
  const dataEnd = data.len;

  // ---- assemble file
  const out = new W();
  for (let i = 0; i < 0x70; i++) out.u8(0);
  const sec = (n: number) => (n ? out.len : 0);
  const stringIds = sec(strList.length); strOffs.forEach((o) => out.u32(o));
  const typeIds = sec(typeList.length); typeList.forEach((t) => out.u32(sIdx.get(t)!));
  const protoIds = sec(protoList.length);
  protoList.forEach(([, [r, ps]], i) => { out.u32(sIdx.get([r, ...ps].map(shortyOf).join(''))!); out.u32(tIdx.get(r)!); out.u32(protoOffs[i]!); });
  const fieldIds = sec(fieldList.length); fieldList.forEach(([, [c, n, t]]) => { out.u16(tIdx.get(c)!); out.u16(tIdx.get(t)!); out.u32(sIdx.get(n)!); });
  const methodIds = sec(methList.length); methList.forEach(([, [c, n, r, ps]]) => { out.u16(tIdx.get(c)!); out.u16(pIdx.get(`${r}(${ps.join('')})`)!); out.u32(sIdx.get(n)!); });
  const classDefs = sec(classes.length);
  classes.forEach((c, i) => {
    out.u32(tIdx.get(c.name)!); out.u32(c.flags ?? 1); out.u32(c.super === null ? 0xffffffff : tIdx.get(c.super ?? 'Ljava/lang/Object;') ?? tIdx.get('Ljava/lang/Object;')!);
    out.u32(ifaceOffs[i]!); out.u32(c.source ? sIdx.get(c.source)! : 0xffffffff); out.u32(dirOffs[i]!); out.u32(classDataOffs[i]!); out.u32(valueOffs[i]!);
  });
  out.b.push(...data.b);
  out.align(4);
  const mapOff = out.len;
  const all: [number, number, number][] = [[0, 1, 0]];
  const add = (t: number, n: number, o: number) => { if (n) all.push([t, n, o]); };
  add(1, strList.length, stringIds); add(2, typeList.length, typeIds); add(3, protoList.length, protoIds);
  add(4, fieldList.length, fieldIds); add(5, methList.length, methodIds); add(6, classes.length, classDefs);
  mapItems.forEach(([t, n, o]) => add(t, n, o));
  all.push([0x1000, 1, mapOff]);
  out.u32(all.length);
  all.forEach(([t, n, o]) => { out.u16(t); out.u16(0); out.u32(n); out.u32(o); });
  const bytes = Uint8Array.from(out.b);
  const dv = new DataView(bytes.buffer);
  bytes.set([0x64, 0x65, 0x78, 0x0a, ...(spec.version ?? '035').split('').map((c) => c.charCodeAt(0)), 0]);
  dv.setUint32(0x20, bytes.length, true); dv.setUint32(0x24, 0x70, true); dv.setUint32(0x28, 0x12345678, true);
  dv.setUint32(0x34, mapOff, true);
  [[strList.length, stringIds], [typeList.length, typeIds], [protoList.length, protoIds], [fieldList.length, fieldIds], [methList.length, methodIds], [classes.length, classDefs]]
    .forEach(([n, o], i) => { dv.setUint32(0x38 + i * 8, n!, true); dv.setUint32(0x3c + i * 8, o!, true); });
  dv.setUint32(0x68, dataEnd, true); dv.setUint32(0x6c, idsEnd, true);
  bytes.set(createHash('sha1').update(bytes.subarray(32)).digest(), 12);
  let a = 1, b = 0;
  for (const x of bytes.subarray(12)) { a = (a + x) % 65521; b = (b + a) % 65521; }
  dv.setUint32(8, ((b << 16) | a) >>> 0, true);
  return bytes;
}
