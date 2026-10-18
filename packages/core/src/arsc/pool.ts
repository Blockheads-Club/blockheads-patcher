/**
 * Android string pool (ResStringPool chunk) as used by resources.arsc. Existing entries keep their original
 * encoded bytes, so an unmodified pool serializes back byte-identically; new strings are appended (indices stay stable).
 */

export class ArscError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ArscError';
  }
}

export const T_STRING_POOL = 0x0001;
export const NONE = 0xffffffff;
const FLAG_SORTED = 0x1;
const FLAG_UTF8 = 0x100;

interface PoolEntry { str: string; raw: Uint8Array }

function decodeUtf8(b: Uint8Array, off: number): { str: string; end: number } {
  let p = off;
  if (b[p++]! & 0x80) p++; // UTF-16 length
  const b0 = b[p++]!;
  const len = b0 & 0x80 ? ((b0 & 0x7f) << 8) | b[p++]! : b0;
  return { str: new TextDecoder().decode(b.subarray(p, p + len)), end: p + len + 1 };
}
function decodeUtf16(dv: DataView, off: number): { str: string; end: number } {
  let p = off;
  let len = dv.getUint16(p, true);
  p += 2;
  if (len & 0x8000) {
    len = ((len & 0x7fff) << 16) | dv.getUint16(p, true);
    p += 2;
  }
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(p + i * 2, true));
  return { str: s, end: p + len * 2 + 2 };
}
function encodeEntry(str: string, utf8: boolean): Uint8Array {
  if (utf8) {
    const data = new TextEncoder().encode(str);
    if (str.length > 0x7fff || data.length > 0x7fff) throw new ArscError('string too long for a UTF-8 pool');
    const len = (n: number): number[] => (n > 0x7f ? [((n >> 8) & 0x7f) | 0x80, n & 0xff] : [n]);
    const head = [...len(str.length), ...len(data.length)];
    const out = new Uint8Array(head.length + data.length + 1);
    out.set(head);
    out.set(data, head.length);
    return out;
  }
  const hdr = str.length > 0x7fff ? 4 : 2;
  const out = new Uint8Array(hdr + str.length * 2 + 2);
  const dv = new DataView(out.buffer);
  if (hdr === 4) {
    dv.setUint16(0, 0x8000 | (str.length >> 16), true);
    dv.setUint16(2, str.length & 0xffff, true);
  } else dv.setUint16(0, str.length, true);
  for (let i = 0; i < str.length; i++) dv.setUint16(hdr + i * 2, str.charCodeAt(i), true);
  return out;
}

export class StringPool {
  private constructor(
    private flags: number,
    private readonly headerSize: number,
    private readonly entries: PoolEntry[],
    private readonly styles: Uint8Array[],
    private readonly styleTail: Uint8Array,
    private readonly index: Map<string, number>,
  ) {}

  /** An empty pool (UTF-8 by default, like aapt2 writes it). */
  static create(utf8 = true): StringPool {
    return new StringPool(utf8 ? FLAG_UTF8 : 0, 28, [], [], new Uint8Array(0), new Map());
  }

  /** Parses the pool chunk starting at `off` (its declared size is returned as `size`). */
  static parse(b: Uint8Array, off: number): { pool: StringPool; size: number } {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (off + 28 > b.length || dv.getUint16(off, true) !== T_STRING_POOL) throw new ArscError(`no string pool at ${off}`);
    const headerSize = dv.getUint16(off + 2, true);
    const size = dv.getUint32(off + 4, true);
    if (off + size > b.length || headerSize < 28 || headerSize > size) throw new ArscError('bad string pool header');
    const count = dv.getUint32(off + 8, true);
    const styleCount = dv.getUint32(off + 12, true);
    const flags = dv.getUint32(off + 16, true);
    const strStart = dv.getUint32(off + 20, true);
    const styStart = dv.getUint32(off + 24, true);
    if (headerSize + (count + styleCount) * 4 > size) throw new ArscError('string pool offset table out of range');
    const utf8 = (flags & FLAG_UTF8) !== 0;
    const entries: PoolEntry[] = [];
    const index = new Map<string, number>();
    for (let i = 0; i < count; i++) {
      const so = off + strStart + dv.getUint32(off + headerSize + i * 4, true);
      if (so >= off + size) throw new ArscError(`string ${i} out of range`);
      const { str, end } = utf8 ? decodeUtf8(b, so) : decodeUtf16(dv, so);
      entries.push({ str, raw: b.slice(so, end) });
      if (!index.has(str)) index.set(str, i);
    }
    const styles: Uint8Array[] = [];
    let styleTail = new Uint8Array(0);
    if (styleCount > 0) {
      let lastEnd = off + styStart;
      for (let i = 0; i < styleCount; i++) {
        const so = off + styStart + dv.getUint32(off + headerSize + (count + i) * 4, true);
        let p = so;
        while (p + 4 <= off + size && dv.getUint32(p, true) !== NONE) p += 12;
        if (p + 4 > off + size) throw new ArscError(`style ${i} is not terminated`);
        p += 4;
        styles.push(b.slice(so, p));
        lastEnd = Math.max(lastEnd, p);
      }
      styleTail = b.slice(lastEnd, off + size);
    }
    return { pool: new StringPool(flags, headerSize, entries, styles, styleTail, index), size };
  }

  get length(): number { return this.entries.length; }
  get isUtf8(): boolean { return (this.flags & FLAG_UTF8) !== 0; }
  get styleCount(): number { return this.styles.length; }

  get(i: number): string {
    const e = this.entries[i];
    if (!e) throw new ArscError(`string index ${i} out of range`);
    return e.str;
  }
  all(): string[] { return this.entries.map((e) => e.str); }
  indexOf(s: string): number { return this.index.get(s) ?? -1; }

  /** Index of `s`, appending it when missing. Appending clears the "sorted" flag (the order is no longer guaranteed). */
  add(s: string): number {
    const have = this.index.get(s);
    if (have !== undefined) return have;
    this.entries.push({ str: s, raw: encodeEntry(s, this.isUtf8) });
    this.flags &= ~FLAG_SORTED;
    this.index.set(s, this.entries.length - 1);
    return this.entries.length - 1;
  }

  serialize(): Uint8Array {
    const n = this.entries.length, sc = this.styles.length;
    const tableEnd = this.headerSize + (n + sc) * 4;
    let strBytes = 0;
    for (const e of this.entries) strBytes += e.raw.length;
    const strPad = (4 - (strBytes % 4)) % 4;
    let styBytes = 0;
    for (const s of this.styles) styBytes += s.length;
    const total = tableEnd + strBytes + strPad + styBytes + this.styleTail.length;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, T_STRING_POOL, true);
    dv.setUint16(2, this.headerSize, true);
    dv.setUint32(4, total, true);
    dv.setUint32(8, n, true);
    dv.setUint32(12, sc, true);
    dv.setUint32(16, this.flags, true);
    dv.setUint32(20, n > 0 ? tableEnd : 0, true);
    dv.setUint32(24, sc > 0 ? tableEnd + strBytes + strPad : 0, true);
    let rel = 0, w = tableEnd;
    this.entries.forEach((e, i) => {
      dv.setUint32(this.headerSize + i * 4, rel, true);
      out.set(e.raw, w);
      w += e.raw.length;
      rel += e.raw.length;
    });
    w += strPad;
    rel = 0;
    this.styles.forEach((s, i) => {
      dv.setUint32(this.headerSize + (n + i) * 4, rel, true);
      out.set(s, w);
      w += s.length;
      rel += s.length;
    });
    out.set(this.styleTail, w);
    return out;
  }
}
