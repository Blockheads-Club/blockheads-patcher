import { ByteReader } from './bytes';
import { adler32, sha1 } from './hash';
import { decodeInsn } from './insns';
import { decodeMutf8, utf16Length } from './mutf8';
import { HEADER_SIZE, NO_INDEX } from './consts';

const BRANCH: Record<string, number> = { '10t': 0, '20t': 0, '30t': 0, '21t': 1, '22t': 2, '31t': 1 };

/**
 * Re-parses a dex independently of the editing model and returns every structural problem found (empty = valid):
 * header, checksum, signature, map list, id-table sorting and ranges, class definition ordering, class data,
 * code items (instruction decoding, index ranges, branch targets, try/catch tables) and type lists.
 */
export function validateDex(bytes: Uint8Array): string[] {
  const errs: string[] = [];
  const err = (m: string): void => { if (errs.length < 50) errs.push(m); };
  try {
    check(bytes, err);
  } catch (e) {
    err(`unreadable: ${(e as Error).message}`);
  }
  return errs;
}

function check(b: Uint8Array, err: (m: string) => void): void {
  if (b.length < HEADER_SIZE) return err('file shorter than the header');
  if (!(b[0] === 0x64 && b[1] === 0x65 && b[2] === 0x78 && b[3] === 0x0a && b[7] === 0 && /^03[5-9]$/.test(String.fromCharCode(b[4]!, b[5]!, b[6]!)))) return err('bad magic or version');
  const r = new ByteReader(b);
  r.pos = 8;
  const checksum = r.u32();
  const signature = b.subarray(12, 32);
  r.pos = 32;
  const fileSize = r.u32(), headerSize = r.u32(), endian = r.u32();
  if (fileSize !== b.length) err(`file_size ${fileSize} != actual ${b.length}`);
  if (headerSize !== HEADER_SIZE) err('bad header_size');
  if (endian !== 0x12345678) err('bad endian tag');
  if (checksum !== adler32(b.subarray(12))) err('checksum mismatch');
  if (sha1(b.subarray(32)).some((v, i) => v !== signature[i])) err('signature mismatch');
  r.pos = 0x34;
  const mapOff = r.u32();
  const sizes = Array.from({ length: 12 }, () => r.u32());
  const [nStr, oStr, nType, oType, nProto, oProto, nField, oField, nMeth, oMeth, nCls, oCls] = sizes as [number, number, number, number, number, number, number, number, number, number, number, number];

  // map list
  const mr = new ByteReader(b, mapOff);
  const mapCount = mr.u32();
  const secs = new Map<number, { count: number; off: number }>();
  let last = -1;
  for (let i = 0; i < mapCount; i++) {
    const type = mr.u16(); mr.u16();
    const count = mr.u32(), off = mr.u32();
    if (off <= last && i > 0) err(`map item 0x${type.toString(16)} out of order`);
    last = off;
    if (off >= b.length) err(`map item 0x${type.toString(16)} offset out of file`);
    if (secs.has(type)) err(`duplicate map item 0x${type.toString(16)}`);
    secs.set(type, { count, off });
  }
  const expect = (type: number, n: number, o: number, name: string): void => {
    const s = secs.get(type);
    if ((s?.count ?? 0) !== n || (n && s!.off !== o)) err(`map entry for ${name} disagrees with the header`);
  };
  expect(1, nStr, oStr, 'string_ids'); expect(2, nType, oType, 'type_ids'); expect(3, nProto, oProto, 'proto_ids');
  expect(4, nField, oField, 'field_ids'); expect(5, nMeth, oMeth, 'method_ids'); expect(6, nCls, oCls, 'class_defs');
  if (secs.get(0x1000)?.off !== mapOff) err('map_list entry does not point at itself');

  // strings
  const strings: string[] = [];
  const sr = new ByteReader(b, oStr);
  for (let i = 0; i < nStr; i++) {
    const dr = new ByteReader(b, sr.u32());
    const ulen = dr.uleb();
    const end = b.indexOf(0, dr.pos);
    const raw = b.subarray(dr.pos, end);
    const s = decodeMutf8(raw);
    if (utf16Length(raw) !== ulen) err(`string ${i}: utf16 length prefix mismatch`);
    if (i > 0 && !(strings[i - 1]! < s)) err(`string ${i} not sorted/unique`);
    strings.push(s);
  }
  // types
  const typeStr: number[] = [];
  const tr = new ByteReader(b, oType);
  for (let i = 0; i < nType; i++) {
    const si = tr.u32();
    if (si >= nStr) { err(`type ${i}: bad descriptor index`); typeStr.push(0); continue; }
    if (i > 0 && si <= typeStr[i - 1]!) err(`type ${i} not sorted/unique`);
    if (!/^(\[*([VZBSCIJFD]|L[^;]+;))$/.test(strings[si]!)) err(`type ${i}: malformed descriptor`);
    typeStr.push(si);
  }
  const tName = (i: number): string => strings[typeStr[i]!]!;
  // type lists
  const typeList = (off: number, what: string): number[] => {
    if (off % 4) err(`${what}: type_list not 4-aligned`);
    const lr = new ByteReader(b, off);
    const n = lr.u32();
    return Array.from({ length: n }, () => {
      const t = lr.u16();
      if (t >= nType) err(`${what}: type index out of range`);
      return t;
    });
  };
  // protos
  const protos: { ret: number; params: number[] }[] = [];
  const pr = new ByteReader(b, oProto);
  for (let i = 0; i < nProto; i++) {
    const sh = pr.u32(), ret = pr.u32(), po = pr.u32();
    if (sh >= nStr || ret >= nType) { err(`proto ${i}: bad index`); protos.push({ ret: 0, params: [] }); continue; }
    const params = po ? typeList(po, `proto ${i}`) : [];
    const shorty = [ret, ...params].map((t) => { const n = tName(t); return n[0] === '[' ? 'L' : n[0]; }).join('');
    if (strings[sh] !== shorty) err(`proto ${i}: shorty ${strings[sh]} != ${shorty}`);
    const prev = protos[i - 1];
    if (prev) {
      const c = ret - prev.ret || lex(params, prev.params);
      if (c <= 0) err(`proto ${i} not sorted/unique`);
    }
    protos.push({ ret, params });
  }
  // fields / methods
  const fieldIds = readIds(b, oField, nField);
  const methodIds = readIds(b, oMeth, nMeth);
  const sortedIds = (ids: { cls: number; mid: number; name: number }[], what: string, limitMid: number): void => {
    ids.forEach((x, i) => {
      if (x.cls >= nType || x.name >= nStr || x.mid >= limitMid) return err(`${what} ${i}: index out of range`);
      const p = ids[i - 1];
      if (p && (x.cls - p.cls || x.name - p.name || x.mid - p.mid) <= 0) err(`${what} ${i} not sorted/unique`);
    });
  };
  sortedIds(fieldIds, 'field', nType);
  sortedIds(methodIds, 'method', nProto);

  // classes
  const cr = new ByteReader(b, oCls);
  const defined = new Map<number, number>();
  const classes: { type: number; flags: number; dataOff: number }[] = [];
  for (let i = 0; i < nCls; i++) {
    const type = cr.u32(), flags = cr.u32();
    cr.pos += 12;
    const ann = cr.u32(), cd = cr.u32(), sv = cr.u32();
    if (type >= nType) { err(`class ${i}: bad type`); continue; }
    if (defined.has(type)) err(`class ${i}: duplicate definition`);
    defined.set(type, i);
    for (const [name, off] of [['annotations_directory', ann], ['class_data', cd], ['static_values', sv]] as const) if (off && off >= b.length) err(`class ${i}: ${name} offset out of file`);
    classes.push({ type, flags, dataOff: cd });
  }
  // superclass / interface ordering: a dependency defined in this dex must come first
  const cr2 = new ByteReader(b, oCls);
  for (let i = 0; i < nCls; i++) {
    cr2.u32(); cr2.u32();
    const sup = cr2.u32(), io = cr2.u32();
    cr2.pos += 16;
    const deps = [...(sup === NO_INDEX ? [] : [sup]), ...(io ? typeList(io, '') : [])];
    for (const dep of deps) {
      if (dep >= nType) { err(`class ${i}: bad superclass/interface`); continue; }
      const at = defined.get(dep);
      if (at !== undefined && at >= i) err(`class ${i}: superclass/interface defined later in the class_defs order`);
    }
  }
  // class data and code
  classes.forEach((c, ci) => {
    if (!c.dataOff) return;
    const d = new ByteReader(b, c.dataOff);
    const [ns, ni, nd, nv] = [d.uleb(), d.uleb(), d.uleb(), d.uleb()];
    const members = (n: number, isMethod: boolean): void => {
      let idx = 0;
      const total = isMethod ? nMeth : nField;
      for (let i = 0; i < n; i++) {
        const delta = d.uleb();
        if (i > 0 && delta === 0) err(`class ${ci}: member indices not ascending`);
        idx += delta;
        d.uleb();
        const co = isMethod ? d.uleb() : 0;
        if (idx >= total) { err(`class ${ci}: member index out of range`); continue; }
        const owner = isMethod ? methodIds[idx]!.cls : fieldIds[idx]!.cls;
        if (owner !== c.type) err(`class ${ci}: member ${idx} belongs to another class`);
        if (co) codeItem(b, co, { nStr, nType, nField, nMeth, nProto }, err);
      }
    };
    members(ns, false); members(ni, false); members(nd, true); members(nv, true);
  });
}

function lex(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

function readIds(b: Uint8Array, off: number, n: number): { cls: number; mid: number; name: number }[] {
  const r = new ByteReader(b, off);
  return Array.from({ length: n }, () => ({ cls: r.u16(), mid: r.u16(), name: r.u32() }));
}

function codeItem(b: Uint8Array, off: number, n: { nStr: number; nType: number; nField: number; nMeth: number; nProto: number }, err: (m: string) => void): void {
  if (off % 4) err(`code item at ${off} not 4-aligned`);
  const r = new ByteReader(b, off);
  const regs = r.u16(), ins = r.u16(), nTries = (r.u16(), r.u16()), dbg = r.u32(), size = r.u32();
  if (ins > regs) err(`code item at ${off}: ins > registers`);
  if (dbg >= b.length) err(`code item at ${off}: debug_info offset out of file`);
  const raw = r.bytes(size * 2);
  const u = new Uint16Array(size);
  for (let i = 0; i < size; i++) u[i] = raw[i * 2]! | (raw[i * 2 + 1]! << 8);
  const starts = new Set<number>();
  for (let at = 0; at < size; ) {
    const i = decodeInsn(u, at);
    starts.add(at);
    if (i.ref) {
      const lim = { string: n.nStr, type: n.nType, field: n.nField, method: n.nMeth }[i.ref.kind];
      if (i.ref.index >= lim) err(`code item at ${off}: ${i.name} ${i.ref.kind} index out of range`);
    }
    const bi = i.format ? BRANCH[i.format] : undefined;
    if (bi !== undefined) {
      const t = at + i.operands[bi]!;
      if (t < 0 || t >= size) err(`code item at ${off}: branch at ${at} leaves the method`);
    }
    at += i.size;
  }
  if (!nTries) return;
  if (size % 2) r.pos += 2;
  const tries = Array.from({ length: nTries }, () => ({ start: r.u32(), count: r.u16(), off: r.u16() }));
  const base = r.pos;
  const nh = r.uleb();
  const hoffs = new Set<number>();
  for (let i = 0; i < nh; i++) {
    hoffs.add(r.pos - base);
    const sz = r.sleb();
    for (let k = 0; k < Math.abs(sz); k++) {
      if (r.uleb() >= n.nType) err(`code item at ${off}: catch type out of range`);
      if (!starts.has(r.uleb())) err(`code item at ${off}: catch address is not an instruction`);
    }
    if (sz <= 0 && !starts.has(r.uleb())) err(`code item at ${off}: catch-all address is not an instruction`);
  }
  let prevEnd = 0;
  for (const t of tries) {
    if (!starts.has(t.start) || t.start < prevEnd || t.start + t.count > size) err(`code item at ${off}: bad try range`);
    if (!hoffs.has(t.off)) err(`code item at ${off}: try handler offset invalid`);
    prevEnd = t.start + t.count;
  }
}
