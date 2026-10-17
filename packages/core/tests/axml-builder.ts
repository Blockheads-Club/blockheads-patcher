/**
 * Synthetic binary-XML (AXML) builder and independent dumper for tests. Lets coverage rely on
 * generated fixtures instead of the user's APKs. Mirrors the layout aapt2 produces.
 */
import { ANDROID_NS } from '../src/axml';

export const NONE = 0xffffffff;
export const T = { XML: 0x0003, POOL: 0x0001, RESMAP: 0x0180, START_NS: 0x0100, END_NS: 0x0101, START_EL: 0x0102, END_EL: 0x0103, CDATA: 0x0104 };

export const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
export const u32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

/** Generic chunk: type, header size, then the remaining header+body words. */
export function chunk(type: number, hsize: number, body: number[]): number[] {
  return [...u16(type), ...u16(hsize), ...u32(8 + body.length), ...body];
}

export function encodeString(s: string, utf8: boolean): number[] {
  if (utf8) {
    const data = Array.from(new TextEncoder().encode(s));
    const cc = s.length;
    return [
      ...(cc > 0x7f ? [0x80 | (cc >> 8), cc & 0xff] : [cc]),
      ...(data.length > 0x7f ? [0x80 | (data.length >> 8), data.length & 0xff] : [data.length]),
      ...data, 0,
    ];
  }
  const head = s.length > 0x7fff ? [...u16(0x8000 | (s.length >> 16)), ...u16(s.length & 0xffff)] : u16(s.length);
  const out = [...head];
  for (let i = 0; i < s.length; i++) out.push(...u16(s.charCodeAt(i)));
  out.push(0, 0);
  return out;
}

/** Builds a string pool chunk. `styles` = number of style entries (for the first strings). */
export function poolChunk(strings: string[], utf8: boolean, styles = 0, styleSpanName = 0): number[] {
  const n = strings.length;
  const encoded = strings.map((s) => encodeString(s, utf8));
  const offsets: number[] = [];
  let strBytes: number[] = [];
  for (const e of encoded) { offsets.push(strBytes.length); strBytes = strBytes.concat(e); }
  while (strBytes.length % 4) strBytes.push(0);
  const styleOffsets: number[] = [];
  let styBytes: number[] = [];
  for (let i = 0; i < styles; i++) {
    styleOffsets.push(styBytes.length);
    styBytes = styBytes.concat([...u32(styleSpanName), ...u32(0), ...u32(1), ...u32(NONE)]);
  }
  if (styles > 0) styBytes = styBytes.concat([...u32(NONE), ...u32(NONE)]);
  const hsize = 28;
  const strStart = hsize + n * 4 + styles * 4;
  const body = [
    ...u32(n), ...u32(styles), ...u32(utf8 ? 0x100 : 0),
    ...u32(n > 0 ? strStart : 0), ...u32(styles > 0 ? strStart + strBytes.length : 0),
    ...offsets.flatMap(u32), ...styleOffsets.flatMap(u32), ...strBytes, ...styBytes,
  ];
  return chunk(T.POOL, hsize, body);
}

export function xmlFile(chunks: number[][], trailing: number[] = []): Uint8Array {
  const all = chunks.flat();
  return Uint8Array.from([...u16(T.XML), ...u16(8), ...u32(8 + all.length), ...all, ...trailing]);
}

// ------------------------------------------------------------------------------------------------

export interface BAttr {
  ns?: string | null;
  name: string;
  /** Android resource id of the attribute name (adds it to the resource map). */
  res?: number;
  /** String value: type String, raw + data point to the interned string. */
  str?: string;
  /** Non-string value type + data. */
  type?: number;
  data?: number;
  /** Raw value string for non-string types. */
  raw?: string;
}
export interface BText { pos: number; value: string; typedString?: boolean }
export interface BEl {
  name: string;
  attrs?: BAttr[];
  children?: BEl[];
  texts?: BText[];
  idIndex?: number;
}
export interface BuildOptions {
  utf8?: boolean;
  /** Declare xmlns:android around the root. Default true. */
  ns?: boolean;
  styles?: number;
  /** Text nodes before / after the root element. */
  before?: string[];
  after?: string[];
  trailing?: number[];
  /** Pad the pool with these extra leading strings (shifts nothing: they are placed after resource names). */
  extraStrings?: string[];
}

export function build(root: BEl, o: BuildOptions = {}): Uint8Array {
  const utf8 = o.utf8 ?? true;
  const strings: string[] = [];
  const resMap: number[] = [];
  const walkAttrs = (e: BEl): void => {
    for (const a of e.attrs ?? []) if (a.res !== undefined && !resMap.includes(a.res)) { strings.push(a.name); resMap.push(a.res); }
    (e.children ?? []).forEach(walkAttrs);
  };
  walkAttrs(root);
  const S = (s: string): number => {
    let i = strings.indexOf(s, resMap.length);
    if (i < 0) { strings.push(s); i = strings.length - 1; }
    return i;
  };
  (o.extraStrings ?? []).forEach(S);
  if (o.styles) S('b');
  const nsIdx = (ns: string | null | undefined): number => (ns ? S(ns) : NONE);
  const chunks: number[][] = [];
  let line = 1;
  const node = (type: number, _hsize: number, words: number[]): number[] => chunk(type, 16, [...u32(line++), ...u32(NONE), ...words]);
  const text = (value: string, typedString = false): number[] => {
    const idx = S(value);
    return node(T.CDATA, 16, [...u32(idx), ...u16(8), 0, typedString ? 3 : 0, ...u32(typedString ? idx : 0)]);
  };
  if (o.ns !== false) chunks.push(node(T.START_NS, 16, [...u32(S('android')), ...u32(S(ANDROID_NS))]));
  for (const t of o.before ?? []) chunks.push(text(t));
  const el = (e: BEl): void => {
    const attrs = e.attrs ?? [];
    const attrBytes = attrs.flatMap((a) => {
      const name = a.res !== undefined ? strings.indexOf(a.name) : S(a.name);
      const nameIdx = a.res !== undefined ? resMap.indexOf(a.res) : name;
      const isStr = a.str !== undefined;
      const rawIdx = isStr ? S(a.str!) : a.raw !== undefined ? S(a.raw) : NONE;
      return [...u32(nsIdx(a.ns === undefined && a.res !== undefined ? ANDROID_NS : a.ns)), ...u32(nameIdx), ...u32(rawIdx),
        ...u16(8), 0, isStr ? 3 : (a.type ?? 0x10), ...u32(isStr ? rawIdx : (a.data ?? 0))];
    });
    const nameIdx = S(e.name);
    chunks.push(node(T.START_EL, 16, [
      ...u32(NONE), ...u32(nameIdx), ...u16(20), ...u16(20), ...u16(attrs.length), ...u16(e.idIndex ?? 0), ...u16(0), ...u16(0), ...attrBytes,
    ]));
    const kids = e.children ?? [];
    const texts = e.texts ?? [];
    for (let i = 0; i <= kids.length; i++) {
      for (const t of texts) if (t.pos === i) chunks.push(text(t.value, t.typedString));
      if (i < kids.length) el(kids[i]!);
    }
    chunks.push(node(T.END_EL, 16, [...u32(NONE), ...u32(nameIdx)]));
  };
  el(root);
  for (const t of o.after ?? []) chunks.push(text(t));
  if (o.ns !== false) chunks.push(node(T.END_NS, 16, [...u32(S('android')), ...u32(S(ANDROID_NS))]));
  const pool = poolChunk(strings, utf8, o.styles ?? 0, o.styles ? S('b') : 0);
  const head: number[][] = [pool];
  if (resMap.length) head.push(chunk(T.RESMAP, 8, resMap.flatMap(u32)));
  return xmlFile([...head, ...chunks], o.trailing);
}

// ------------------------------------------------------------------------------------------------
// Independent decoder -> readable lines (used to assert semantic preservation across mutations).

function decodePool(b: Uint8Array, off: number): string[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = dv.getUint32(off + 8, true), flags = dv.getUint32(off + 16, true), start = dv.getUint32(off + 20, true);
  const utf8 = (flags & 0x100) !== 0;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let p = off + start + dv.getUint32(off + 28 + i * 4, true);
    if (utf8) {
      if (b[p]! & 0x80) p++;
      p++;
      let len = b[p++]!;
      if (len & 0x80) len = ((len & 0x7f) << 8) | b[p++]!;
      out.push(new TextDecoder().decode(b.subarray(p, p + len)));
    } else {
      let len = dv.getUint16(p, true);
      p += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | dv.getUint16(p, true); p += 2; }
      let s = '';
      for (let k = 0; k < len; k++) s += String.fromCharCode(dv.getUint16(p + k * 2, true));
      out.push(s);
    }
  }
  return out;
}

/** One line per chunk with every string reference resolved. Attribute order is preserved. */
export function dump(b: Uint8Array): string[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pool: string[] = [];
  const res: number[] = [];
  const s = (i: number): string => (i === NONE ? '-' : (pool[i] ?? `?${i}`));
  const lines: string[] = [];
  const total = dv.getUint32(4, true);
  for (let off = 8; off < total;) {
    const type = dv.getUint16(off, true), size = dv.getUint32(off + 4, true);
    const w = (o: number): number => dv.getUint32(off + o, true);
    if (type === T.POOL) { pool = decodePool(b, off); lines.push(`pool ${pool.length}`); }
    else if (type === T.RESMAP) { for (let p = off + 8; p < off + size; p += 4) res.push(dv.getUint32(p, true)); lines.push(`resmap ${res.length}`); }
    else if (type === T.START_NS) lines.push(`ns ${s(w(16))}=${s(w(20))}`);
    else if (type === T.END_NS) lines.push(`/ns ${s(w(16))}=${s(w(20))}`);
    else if (type === T.CDATA) lines.push(`text ${s(w(16))} typed=${b[off + 23]!}:${b[off + 23] === 3 ? s(w(24)) : w(24)}`);
    else if (type === T.END_EL) lines.push(`/el ${s(w(16))}:${s(w(20))}`);
    else if (type === T.START_EL) {
      const count = dv.getUint16(off + 28, true);
      const attrs: string[] = [];
      for (let i = 0; i < count; i++) {
        const a = off + 36 + i * 20;
        const nameIdx = dv.getUint32(a + 4, true), vt = b[a + 15]!, data = dv.getUint32(a + 16, true);
        const rid = nameIdx < res.length ? res[nameIdx]!.toString(16) : '-';
        attrs.push(`${s(dv.getUint32(a, true))}:${s(nameIdx)}[${rid}]raw=${s(dv.getUint32(a + 8, true))}/${vt}:${vt === 3 ? s(data) : data}`);
      }
      lines.push(`el ${s(w(16))}:${s(w(20))} id=${dv.getUint16(off + 30, true)} ${attrs.join(' ')}`);
    }
    off += size;
  }
  return lines;
}
