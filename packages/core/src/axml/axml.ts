/**
 * Android binary XML (AXML) parser / serializer.
 * Unmodified documents round-trip byte-identically: string pool entries keep their original encoded bytes,
 * and all structural header fields are preserved in private metadata.
 */

export const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

export const enum ValueType {
  Null = 0x00,
  Reference = 0x01,
  Attribute = 0x02,
  String = 0x03,
  Float = 0x04,
  Dimension = 0x05,
  Fraction = 0x06,
  IntDec = 0x10,
  IntHex = 0x11,
  IntBoolean = 0x12,
  IntColorArgb8 = 0x1c,
  IntColorRgb8 = 0x1d,
  IntColorArgb4 = 0x1e,
  IntColorRgb4 = 0x1f,
}

export interface AxmlAttribute {
  nsUri: string | null;
  name: string;
  resourceId: number | null;
  rawValue: string | null;
  valueType: ValueType;
  data: number;
  stringValue?: string;
}
export interface AxmlElement {
  name: string;
  nsUri: string | null;
  attributes: AxmlAttribute[];
  children: AxmlElement[];
  lineNumber: number;
}
export interface AxmlDocument {
  root: AxmlElement;
}
export class AxmlError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AxmlError';
  }
}

// ---------------------------------------------------------------------------------------------
// Internal state

const NONE = 0xffffffff;
const T_XML = 0x0003, T_POOL = 0x0001, T_RESMAP = 0x0180;
const T_START_NS = 0x0100, T_END_NS = 0x0101, T_START_EL = 0x0102, T_END_EL = 0x0103, T_CDATA = 0x0104;
const FLAG_UTF8 = 0x100;

interface PoolEntry { str: string; raw: Uint8Array }
interface Pool {
  flags: number;
  entries: PoolEntry[];
  styles: Uint8Array[]; // raw style blocks (spans + 0xFFFFFFFF terminator)
  styleTail: Uint8Array; // bytes after the last style (usually 8x 0xFF)
  headerSize: number;
}
interface NsNode { line: number; comment: number; prefix: number; uri: number; endLine: number; endComment: number }
interface CdataNode { pos?: number; line: number; comment: number; data: number; typed: Uint8Array; afterRoot: boolean }
interface State { cdata: CdataNode[]; pool: Pool; resMap: number[] | null; resMapHeader: Uint8Array | null; ns: NsNode[]; trailing: Uint8Array; fileHeaderSize: number }
interface ElMeta {
  nsIdx: number; nameIdx: number; comment: number; endLine: number; endComment: number; endNs: number; endName: number;
  cdata: CdataNode[]; attrStart: number; attrSize: number; idIndex: number; classIndex: number; styleIndex: number;
}
interface AttrMeta { nsIdx: number; nameIdx: number; rawIdx: number; size: number; res0: number }

const states = new WeakMap<object, State>();
const elMeta = new WeakMap<object, ElMeta>();
const attrMeta = new WeakMap<object, AttrMeta>();

function stateOf(doc: AxmlDocument): State {
  const s = states.get(doc);
  if (!s) throw new AxmlError('document was not created by parseAxml');
  return s;
}

// ---------------------------------------------------------------------------------------------
// String pool decode / encode

function decodeUtf8Entry(b: Uint8Array, off: number): { str: string; end: number } {
  let p = off;
  let b0 = b[p++]!;
  if (b0 & 0x80) p++; // char count (ignored)
  b0 = b[p++]!;
  let len = b0;
  if (b0 & 0x80) len = ((b0 & 0x7f) << 8) | b[p++]!;
  const str = new TextDecoder('utf-8').decode(b.subarray(p, p + len));
  return { str, end: p + len + 1 };
}
function decodeUtf16Entry(dv: DataView, off: number): { str: string; end: number } {
  let p = off;
  let len = dv.getUint16(p, true);
  p += 2;
  if (len & 0x8000) {
    len = ((len & 0x7fff) << 16) | dv.getUint16(p, true);
    p += 2;
  }
  const chars: string[] = [];
  for (let i = 0; i < len; i++) chars.push(String.fromCharCode(dv.getUint16(p + i * 2, true)));
  return { str: chars.join(''), end: p + len * 2 + 2 };
}
function encodeEntry(str: string, utf8: boolean): Uint8Array {
  if (utf8) {
    const data = new TextEncoder().encode(str);
    const out: number[] = [];
    const cc = str.length;
    if (cc > 0x7f) out.push(((cc >> 8) & 0x7f) | 0x80, cc & 0xff); else out.push(cc);
    if (data.length > 0x7f) out.push(((data.length >> 8) & 0x7f) | 0x80, data.length & 0xff); else out.push(data.length);
    const r = new Uint8Array(out.length + data.length + 1);
    r.set(out);
    r.set(data, out.length);
    return r;
  }
  const hdr = str.length > 0x7fff ? 4 : 2;
  const r = new Uint8Array(hdr + str.length * 2 + 2);
  const dv = new DataView(r.buffer);
  if (hdr === 4) {
    dv.setUint16(0, 0x8000 | (str.length >> 16), true);
    dv.setUint16(2, str.length & 0xffff, true);
  } else dv.setUint16(0, str.length, true);
  for (let i = 0; i < str.length; i++) dv.setUint16(hdr + i * 2, str.charCodeAt(i), true);
  return r;
}

function parsePool(b: Uint8Array, dv: DataView, off: number, size: number): Pool {
  const headerSize = dv.getUint16(off + 2, true);
  const strCount = dv.getUint32(off + 8, true);
  const styleCount = dv.getUint32(off + 12, true);
  const flags = dv.getUint32(off + 16, true);
  const strStart = dv.getUint32(off + 20, true);
  const styStart = dv.getUint32(off + 24, true);
  const utf8 = (flags & FLAG_UTF8) !== 0;
  const entries: PoolEntry[] = [];
  const offTable = off + headerSize;
  for (let i = 0; i < strCount; i++) {
    const so = off + strStart + dv.getUint32(offTable + i * 4, true);
    const { str, end } = utf8 ? decodeUtf8Entry(b, so) : decodeUtf16Entry(dv, so);
    entries.push({ str, raw: b.slice(so, end) });
  }
  const styles: Uint8Array[] = [];
  let styleTail = new Uint8Array(0);
  if (styleCount > 0) {
    const styTable = offTable + strCount * 4;
    let lastEnd = off + styStart;
    for (let i = 0; i < styleCount; i++) {
      const so = off + styStart + dv.getUint32(styTable + i * 4, true);
      let p = so;
      while (dv.getUint32(p, true) !== NONE) p += 12;
      p += 4;
      styles.push(b.slice(so, p));
      lastEnd = Math.max(lastEnd, p);
    }
    styleTail = b.slice(lastEnd, off + size);
  }
  return { flags, entries, styles, styleTail, headerSize };
}

function serializePool(p: Pool): Uint8Array {
  const n = p.entries.length, sc = p.styles.length;
  const tableEnd = p.headerSize + n * 4 + sc * 4;
  let strBytes = 0;
  for (const e of p.entries) strBytes += e.raw.length;
  const strPad = (4 - (strBytes % 4)) % 4;
  let styBytes = 0;
  for (const s of p.styles) styBytes += s.length;
  const total = tableEnd + strBytes + strPad + styBytes + p.styleTail.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, T_POOL, true);
  dv.setUint16(2, p.headerSize, true);
  dv.setUint32(4, total, true);
  dv.setUint32(8, n, true);
  dv.setUint32(12, sc, true);
  dv.setUint32(16, p.flags, true);
  dv.setUint32(20, n > 0 ? tableEnd : 0, true);
  dv.setUint32(24, sc > 0 ? tableEnd + strBytes + strPad : 0, true);
  let rel = 0, w = tableEnd;
  p.entries.forEach((e, i) => {
    dv.setUint32(p.headerSize + i * 4, rel, true);
    out.set(e.raw, w);
    w += e.raw.length;
    rel += e.raw.length;
  });
  w += strPad;
  rel = 0;
  p.styles.forEach((s, i) => {
    dv.setUint32(p.headerSize + n * 4 + i * 4, rel, true);
    out.set(s, w);
    w += s.length;
    rel += s.length;
  });
  out.set(p.styleTail, w);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Parse

function str(pool: Pool, idx: number): string | null {
  if (idx === NONE) return null;
  const e = pool.entries[idx];
  if (!e) throw new AxmlError(`string index ${idx} out of range`);
  return e.str;
}

export function parseAxml(bytes: Uint8Array): AxmlDocument {
  if (bytes.length < 8) throw new AxmlError('file too small');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(0, true) !== T_XML) throw new AxmlError('not a binary XML file (bad magic)');
  const fileHeaderSize = dv.getUint16(2, true);
  const fileSize = dv.getUint32(4, true);
  if (fileSize > bytes.length || fileSize < fileHeaderSize) throw new AxmlError('bad file size');
  let off = fileHeaderSize;
  let pool: Pool | null = null;
  let resMap: number[] | null = null;
  let resMapHeader: Uint8Array | null = null;
  const nsNodes: NsNode[] = [];
  const nsStack: NsNode[] = [];
  const stack: AxmlElement[] = [];
  const cdata: CdataNode[] = [];
  let root: AxmlElement | null = null;

  while (off < fileSize) {
    if (off + 8 > fileSize) throw new AxmlError('truncated chunk header');
    const type = dv.getUint16(off, true);
    const hsize = dv.getUint16(off + 2, true);
    const size = dv.getUint32(off + 4, true);
    if (size < 8 || off + size > fileSize) throw new AxmlError(`bad chunk size at ${off}`);
    const bytesAt = (o: number) => dv.getUint32(off + o, true);
    switch (type) {
      case T_POOL:
        if (pool) throw new AxmlError('duplicate string pool');
        pool = parsePool(bytes, dv, off, size);
        break;
      case T_RESMAP: {
        resMapHeader = bytes.slice(off, off + hsize);
        resMap = [];
        for (let p = off + hsize; p + 4 <= off + size; p += 4) resMap.push(dv.getUint32(p, true));
        break;
      }
      default: {
        if (!pool) throw new AxmlError('node chunk before string pool');
        if (hsize !== 16) throw new AxmlError(`unexpected node header size ${hsize}`);
        const line = bytesAt(8), comment = bytesAt(12);
        if (type === T_START_NS) {
          if (stack.length) throw new AxmlError('namespace declared inside element is unsupported');
          const n: NsNode = { line, comment, prefix: bytesAt(16), uri: bytesAt(20), endLine: 0, endComment: NONE };
          nsNodes.push(n);
          nsStack.push(n);
        } else if (type === T_END_NS) {
          const n = nsStack.pop();
          if (!n) throw new AxmlError('unbalanced end namespace');
          n.endLine = line;
          n.endComment = comment;
        } else if (type === T_START_EL) {
          const nsIdx = bytesAt(16), nameIdx = bytesAt(20);
          const attrStart = dv.getUint16(off + 24, true), attrSize = dv.getUint16(off + 26, true);
          const count = dv.getUint16(off + 28, true);
          if (attrSize !== 20) throw new AxmlError(`unexpected attribute size ${attrSize}`);
          const el: AxmlElement = { name: str(pool, nameIdx) ?? '', nsUri: str(pool, nsIdx), attributes: [], children: [], lineNumber: line };
          elMeta.set(el, {
            nsIdx, nameIdx, comment, cdata: [], endLine: 0, endComment: NONE, endNs: NONE, endName: NONE, attrStart, attrSize,
            idIndex: dv.getUint16(off + 30, true), classIndex: dv.getUint16(off + 32, true), styleIndex: dv.getUint16(off + 34, true),
          });
          for (let i = 0; i < count; i++) {
            const a = off + 16 + attrStart + i * attrSize;
            if (a + 20 > off + size) throw new AxmlError('attribute out of chunk');
            const ans = dv.getUint32(a, true), an = dv.getUint32(a + 4, true), raw = dv.getUint32(a + 8, true);
            const vtype = bytes[a + 15]! as ValueType, data = dv.getUint32(a + 16, true);
            const attr: AxmlAttribute = {
              nsUri: str(pool, ans), name: str(pool, an) ?? '',
              resourceId: resMap && an < resMap.length ? resMap[an]! : null,
              rawValue: str(pool, raw), valueType: vtype, data,
            };
            if (vtype === ValueType.String) attr.stringValue = str(pool, data) ?? '';
            attrMeta.set(attr, { nsIdx: ans, nameIdx: an, rawIdx: raw, size: dv.getUint16(a + 8 + 4 - 4 + 4, true), res0: bytes[a + 14]! });
            el.attributes.push(attr);
          }
          const parent = stack[stack.length - 1];
          if (parent) parent.children.push(el);
          else if (root) throw new AxmlError('multiple root elements');
          else root = el;
          stack.push(el);
        } else if (type === T_END_EL) {
          const el = stack.pop();
          if (!el) throw new AxmlError('unbalanced end element');
          const m = elMeta.get(el)!;
          m.endLine = line;
          m.endComment = comment;
          m.endNs = bytesAt(16);
          m.endName = bytesAt(20);
        } else if (type === T_CDATA) {
          const cur = stack[stack.length - 1];
          const node: CdataNode = { line, comment, data: bytesAt(16), typed: bytes.slice(off + 20, off + 28), afterRoot: root !== null };
          if (cur) { node.pos = cur.children.length; elMeta.get(cur)!.cdata.push(node); } else cdata.push(node);
        } else throw new AxmlError(`unknown chunk type 0x${type.toString(16)}`);
      }
    }
    off += size;
  }
  if (!pool) throw new AxmlError('missing string pool');
  if (!root || stack.length || nsStack.length) throw new AxmlError('missing or unbalanced root element');
  const doc: AxmlDocument = { root };
  states.set(doc, { cdata, pool, resMap, resMapHeader, ns: nsNodes, trailing: bytes.slice(fileSize), fileHeaderSize });
  return doc;
}

// ---------------------------------------------------------------------------------------------
// Serialize

export function serializeAxml(doc: AxmlDocument): Uint8Array {
  const s = stateOf(doc);
  const chunks: Uint8Array[] = [serializePool(s.pool)];
  if (s.resMap) {
    const c = new Uint8Array(s.resMapHeader!.length + s.resMap.length * 4);
    c.set(s.resMapHeader!);
    const dv = new DataView(c.buffer);
    dv.setUint32(4, c.length, true);
    s.resMap.forEach((v, i) => dv.setUint32(s.resMapHeader!.length + i * 4, v, true));
    chunks.push(c);
  }
  const node = (type: number, line: number, comment: number, body: number[]): Uint8Array => {
    const c = new Uint8Array(16 + body.length * 4);
    const dv = new DataView(c.buffer);
    dv.setUint16(0, type, true);
    dv.setUint16(2, 16, true);
    dv.setUint32(4, c.length, true);
    dv.setUint32(8, line, true);
    dv.setUint32(12, comment, true);
    body.forEach((v, i) => dv.setUint32(16 + i * 4, v >>> 0, true));
    return c;
  };
  for (const n of s.ns) chunks.push(node(T_START_NS, n.line, n.comment, [n.prefix, n.uri]));
  const emitCdata = (list: CdataNode[]): void => {
    for (const c of list) {
      const ch = new Uint8Array(28);
      ch.set(node(T_CDATA, c.line, c.comment, [c.data]));
      ch.set(c.typed, 20);
      new DataView(ch.buffer).setUint32(4, 28, true);
      chunks.push(ch);
    }
  };
  const writeCdata = (after: boolean): void => emitCdata(s.cdata.filter((c) => c.afterRoot === after));
  writeCdata(false);
  const writeEl = (el: AxmlElement): void => {
    const m = elMeta.get(el);
    if (!m) throw new AxmlError('element was not created by parseAxml');
    const count = el.attributes.length;
    const c = new Uint8Array(16 + 20 + count * 20);
    const dv = new DataView(c.buffer);
    dv.setUint16(0, T_START_EL, true);
    dv.setUint16(2, 16, true);
    dv.setUint32(4, c.length, true);
    dv.setUint32(8, el.lineNumber, true);
    dv.setUint32(12, m.comment, true);
    dv.setUint32(16, m.nsIdx, true);
    dv.setUint32(20, m.nameIdx, true);
    dv.setUint16(24, m.attrStart, true);
    dv.setUint16(26, m.attrSize, true);
    dv.setUint16(28, count, true);
    dv.setUint16(30, m.idIndex, true);
    dv.setUint16(32, m.classIndex, true);
    dv.setUint16(34, m.styleIndex, true);
    el.attributes.forEach((a, i) => {
      const am = attrMeta.get(a);
      if (!am) throw new AxmlError('attribute was not created by parseAxml/addAttr');
      const p = 36 + i * 20;
      dv.setUint32(p, am.nsIdx, true);
      dv.setUint32(p + 4, am.nameIdx, true);
      dv.setUint32(p + 8, am.rawIdx, true);
      dv.setUint16(p + 12, am.size, true);
      c[p + 14] = am.res0;
      c[p + 15] = a.valueType;
      dv.setUint32(p + 16, a.data >>> 0, true);
    });
    chunks.push(c);
    el.children.forEach((ch, i) => { emitCdata(m.cdata.filter((c) => c.pos === i)); writeEl(ch); });
    emitCdata(m.cdata.filter((c) => c.pos === el.children.length));
    chunks.push(node(T_END_EL, m.endLine, m.endComment, [m.endNs, m.endName]));
  };
  writeEl(doc.root);
  writeCdata(true);
  for (let i = s.ns.length - 1; i >= 0; i--) {
    const n = s.ns[i]!;
    chunks.push(node(T_END_NS, n.endLine, n.endComment, [n.prefix, n.uri]));
  }
  let total = s.fileHeaderSize + s.trailing.length;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, T_XML, true);
  dv.setUint16(2, s.fileHeaderSize, true);
  dv.setUint32(4, total - s.trailing.length, true);
  let w = s.fileHeaderSize;
  for (const c of chunks) { out.set(c, w); w += c.length; }
  out.set(s.trailing, w);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Query helpers

export function findElements(doc: AxmlDocument, predicate: (e: AxmlElement, path: string[]) => boolean): AxmlElement[] {
  const res: AxmlElement[] = [];
  const walk = (e: AxmlElement, path: string[]): void => {
    const p = [...path, e.name];
    if (predicate(e, p)) res.push(e);
    for (const c of e.children) walk(c, p);
  };
  walk(doc.root, []);
  return res;
}

/** Matches by resourceId when given, else by (nsUri,name). nsUri undefined = any namespace. */
export function getAttr(el: AxmlElement, name: string, nsUri?: string | null, resourceId?: number): AxmlAttribute | undefined {
  if (resourceId !== undefined) {
    const hit = el.attributes.find((a) => a.resourceId === resourceId);
    if (hit) return hit;
  }
  return el.attributes.find((a) => a.name === name && (nsUri === undefined || a.nsUri === nsUri));
}

/** Find elements with the given tag whose android:name string equals `name`. */
export function findElementsByName(doc: AxmlDocument, tag: string, name: string): AxmlElement[] {
  return findElements(doc, (e) => e.name === tag && getAttr(e, 'name', ANDROID_NS, 0x01010003)?.stringValue === name);
}

// ---------------------------------------------------------------------------------------------
// Mutation

export function setAttrValue(doc: AxmlDocument, attr: AxmlAttribute, valueType: ValueType, data: number): void {
  stateOf(doc);
  const am = attrMeta.get(attr);
  if (!am) throw new AxmlError('unknown attribute');
  if (attr.valueType === ValueType.String && valueType !== ValueType.String) {
    am.rawIdx = NONE;
    attr.rawValue = null;
  }
  attr.valueType = valueType;
  attr.data = data >>> 0;
  if (valueType === ValueType.String) {
    attr.stringValue = str(stateOf(doc).pool, attr.data) ?? '';
  } else delete attr.stringValue;
}

function internString(s: State, value: string, minIndex = 0): number {
  for (let i = minIndex; i < s.pool.entries.length; i++) if (s.pool.entries[i]!.str === value) return i;
  s.pool.entries.push({ str: value, raw: encodeEntry(value, (s.pool.flags & FLAG_UTF8) !== 0) });
  return s.pool.entries.length - 1;
}

export function setAttrString(doc: AxmlDocument, attr: AxmlAttribute, value: string): void {
  const s = stateOf(doc);
  const am = attrMeta.get(attr);
  if (!am) throw new AxmlError('unknown attribute');
  const resLen = s.resMap?.length ?? 0;
  const idx = internString(s, value, resLen);
  am.rawIdx = idx;
  attr.rawValue = value;
  attr.valueType = ValueType.String;
  attr.data = idx;
  attr.stringValue = value;
}

/** Insert a string at pool index `at`, shifting all references >= at. */
function insertStringAt(doc: AxmlDocument, s: State, at: number, value: string): void {
  const sh = (i: number): number => (i !== NONE && i >= at ? i + 1 : i);
  s.pool.entries.splice(at, 0, { str: value, raw: encodeEntry(value, (s.pool.flags & FLAG_UTF8) !== 0) });
  if (at < s.pool.styles.length) s.pool.styles.splice(at, 0, new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  const shCdata = (c: CdataNode): void => {
    c.data = sh(c.data); c.comment = sh(c.comment);
    if (c.typed[3] === ValueType.String) {
      const dv = new DataView(c.typed.buffer, c.typed.byteOffset, c.typed.byteLength);
      dv.setUint32(4, sh(dv.getUint32(4, true)), true);
    }
  };
  for (const c of s.cdata) shCdata(c);
  for (const n of s.ns) { n.prefix = sh(n.prefix); n.uri = sh(n.uri); n.comment = sh(n.comment); n.endComment = sh(n.endComment); }
  const walk = (e: AxmlElement): void => {
    const m = elMeta.get(e)!;
    for (const c of m.cdata) shCdata(c);
    m.nsIdx = sh(m.nsIdx); m.nameIdx = sh(m.nameIdx); m.comment = sh(m.comment);
    m.endComment = sh(m.endComment); m.endNs = sh(m.endNs); m.endName = sh(m.endName);
    for (const a of e.attributes) {
      const am = attrMeta.get(a)!;
      am.nsIdx = sh(am.nsIdx); am.nameIdx = sh(am.nameIdx); am.rawIdx = sh(am.rawIdx);
      if (a.valueType === ValueType.String) a.data = sh(a.data);
    }
    e.children.forEach(walk);
  };
  walk(doc.root);
}

/**
 * Add an attribute, keeping attributes with resource ids sorted by id (ids first, then id-less ones).
 * For ValueType.String, `rawValue` is required and interned; `data` is ignored.
 */
export function addAttr(doc: AxmlDocument, el: AxmlElement, a: Omit<AxmlAttribute, 'stringValue'>): AxmlAttribute {
  const s = stateOf(doc);
  const m = elMeta.get(el);
  if (!m) throw new AxmlError('unknown element');
  if (a.resourceId !== null && a.resourceId !== undefined) {
    if (!s.resMap) { s.resMap = []; s.resMapHeader = new Uint8Array([0x80, 0x01, 0x08, 0x00, 8, 0, 0, 0]); }
  }
  // namespace
  let nsIdx = NONE;
  if (a.nsUri !== null) nsIdx = internString(s, a.nsUri);
  // name
  let nameIdx: number;
  if (a.resourceId !== null) {
    const rm = s.resMap!;
    nameIdx = -1;
    for (let i = 0; i < rm.length; i++) if (rm[i] === a.resourceId && s.pool.entries[i]?.str === a.name) { nameIdx = i; break; }
    if (nameIdx < 0) {
      nameIdx = rm.length;
      insertStringAt(doc, s, nameIdx, a.name);
      rm.push(a.resourceId);
      // nsIdx may have shifted; recompute
      if (a.nsUri !== null) nsIdx = internString(s, a.nsUri);
    }
  } else {
    nameIdx = internString(s, a.name, s.resMap?.length ?? 0);
  }
  let rawIdx = NONE, data = a.data >>> 0, rawValue = a.rawValue;
  if (a.valueType === ValueType.String) {
    if (rawValue === null) throw new AxmlError('rawValue required for String attributes');
    rawIdx = data = internString(s, rawValue, s.resMap?.length ?? 0);
  } else if (rawValue !== null) rawIdx = internString(s, rawValue, s.resMap?.length ?? 0);
  // nameIdx / nsIdx could not have shifted after the last intern (appends only)
  const attr: AxmlAttribute = {
    nsUri: a.nsUri, name: a.name, resourceId: a.resourceId, rawValue, valueType: a.valueType, data,
  };
  if (a.valueType === ValueType.String) attr.stringValue = rawValue!;
  attrMeta.set(attr, { nsIdx, nameIdx, rawIdx, size: 8, res0: 0 });
  // sorted insert
  const key = (x: AxmlAttribute): number => (x.resourceId === null ? Infinity : x.resourceId);
  let pos = el.attributes.length;
  for (let i = 0; i < el.attributes.length; i++) if (key(el.attributes[i]!) > key(attr)) { pos = i; break; }
  el.attributes.splice(pos, 0, attr);
  for (const k of ['idIndex', 'classIndex', 'styleIndex'] as const) if (m[k] !== 0 && m[k] > pos) m[k]++;
  return attr;
}

// ---------------------------------------------------------------------------------------------
// Element / namespace mutation

/** Attribute description for {@link insertElement}. Strings are interned; platform attributes need their `resourceId`. */
export interface AttrSpec {
  name: string;
  /** Namespace URI; must already be declared (see {@link declareNamespace}). Omit or null for none. */
  nsUri?: string | null;
  resourceId?: number | null;
  /** String value (type String). Mutually exclusive with `valueType`/`data`. */
  value?: string;
  valueType?: ValueType;
  data?: number;
}
/** Element description for {@link insertElement}. */
export interface ElementSpec {
  name: string;
  nsUri?: string | null;
  attributes?: AttrSpec[];
  children?: ElementSpec[];
}

/** Declares `xmlns:prefix=uri` around the whole document unless the URI is already declared. Returns true when added. */
export function declareNamespace(doc: AxmlDocument, prefix: string, uri: string): boolean {
  const s = stateOf(doc);
  const known = s.ns.some((n) => s.pool.entries[n.uri]?.str === uri);
  if (known) return false;
  const minIdx = s.resMap?.length ?? 0;
  const prefixIdx = internString(s, prefix, minIdx);
  const uriIdx = internString(s, uri, minIdx);
  s.ns.push({ line: 1, comment: NONE, prefix: prefixIdx, uri: uriIdx, endLine: lastLine(doc) + 1, endComment: NONE });
  return true;
}

function lastLine(doc: AxmlDocument): number {
  let max = 0;
  const walk = (e: AxmlElement): void => {
    max = Math.max(max, e.lineNumber, elMeta.get(e)!.endLine);
    e.children.forEach(walk);
  };
  walk(doc.root);
  for (const n of stateOf(doc).ns) max = Math.max(max, n.line, n.endLine);
  return max;
}

/**
 * Inserts a new element (and its subtree) as child number `index` of `parent` (default: last). Strings and
 * resource-id map entries are added to the pool, attributes are kept sorted by resource id, and new elements get fresh
 * line numbers after the last existing one. Text nodes that sat before child `index` stay before the old child.
 */
export function insertElement(doc: AxmlDocument, parent: AxmlElement, spec: ElementSpec, index: number = parent.children.length): AxmlElement {
  const s = stateOf(doc);
  const pm = elMeta.get(parent);
  if (!pm) throw new AxmlError('unknown element');
  if (!Number.isInteger(index) || index < 0 || index > parent.children.length) throw new AxmlError(`child index ${index} out of range`);
  const declared = (uri: string): boolean => s.ns.some((n) => s.pool.entries[n.uri]?.str === uri);
  const check = (e: ElementSpec): void => {
    if (e.nsUri && !declared(e.nsUri)) throw new AxmlError(`namespace not declared: ${e.nsUri}`);
    for (const a of e.attributes ?? []) if (a.nsUri && !declared(a.nsUri)) throw new AxmlError(`namespace not declared: ${a.nsUri}`);
    (e.children ?? []).forEach(check);
  };
  check(spec);
  let line = lastLine(doc);
  const build = (par: AxmlElement, sp: ElementSpec, at: number): void => {
    const m = elMeta.get(par)!;
    for (const c of m.cdata) if (c.pos !== undefined && c.pos >= at) c.pos++;
    const minIdx = s.resMap?.length ?? 0;
    const nameIdx = internString(s, sp.name, minIdx);
    const nsIdx = sp.nsUri ? internString(s, sp.nsUri, minIdx) : NONE;
    const el: AxmlElement = { name: sp.name, nsUri: sp.nsUri ?? null, attributes: [], children: [], lineNumber: ++line };
    elMeta.set(el, {
      nsIdx, nameIdx, comment: NONE, cdata: [], endLine: ++line, endComment: NONE, endNs: nsIdx, endName: nameIdx,
      attrStart: 20, attrSize: 20, idIndex: 0, classIndex: 0, styleIndex: 0,
    });
    par.children.splice(at, 0, el);
    for (const a of sp.attributes ?? []) {
      const isStr = a.value !== undefined;
      addAttr(doc, el, {
        nsUri: a.nsUri ?? null, name: a.name, resourceId: a.resourceId ?? null, rawValue: isStr ? a.value! : null,
        valueType: isStr ? ValueType.String : (a.valueType ?? ValueType.IntDec), data: a.data ?? 0,
      });
    }
    (sp.children ?? []).forEach((c, i) => build(el, c, i));
  };
  build(parent, spec, index);
  // the element's own end line must come after its subtree
  const created = parent.children[index]!;
  const fix = (e: AxmlElement): void => { e.children.forEach(fix); elMeta.get(e)!.endLine = ++line; };
  fix(created);
  return created;
}

/** Removes `child` (with its subtree and text nodes) from `parent`. Strings stay in the pool (harmless, keeps indices stable). */
export function removeElement(doc: AxmlDocument, parent: AxmlElement, child: AxmlElement): void {
  stateOf(doc);
  const pm = elMeta.get(parent);
  if (!pm) throw new AxmlError('unknown element');
  const at = parent.children.indexOf(child);
  if (at < 0) throw new AxmlError('element is not a child of the given parent');
  parent.children.splice(at, 1);
  for (const c of pm.cdata) if (c.pos !== undefined && c.pos > at) c.pos--;
}

/** Removes an attribute from its element (the string stays in the pool). */
export function removeAttr(doc: AxmlDocument, el: AxmlElement, attr: AxmlAttribute): void {
  stateOf(doc);
  const m = elMeta.get(el);
  if (!m) throw new AxmlError('unknown element');
  const pos = el.attributes.indexOf(attr);
  if (pos < 0) throw new AxmlError('attribute does not belong to the element');
  el.attributes.splice(pos, 1);
  for (const k of ['idIndex', 'classIndex', 'styleIndex'] as const) {
    if (m[k] === pos + 1) m[k] = 0;
    else if (m[k] > pos + 1) m[k]--;
  }
}

// ---------------------------------------------------------------------------------------------
// Manifest info

export interface ManifestInfo {
  package: string;
  versionName?: string;
  versionCode?: number;
  minSdk?: number;
  targetSdk?: number;
}

const ID_VERSION_CODE = 0x0101021b, ID_VERSION_NAME = 0x0101021c, ID_MIN_SDK = 0x0101020c, ID_TARGET_SDK = 0x01010270;

export function manifestInfo(doc: AxmlDocument): ManifestInfo {
  const root = doc.root;
  if (root.name !== 'manifest') throw new AxmlError('root element is not <manifest>');
  const pkg = getAttr(root, 'package', null);
  if (!pkg || pkg.valueType !== ValueType.String) throw new AxmlError('manifest has no package attribute');
  const info: ManifestInfo = { package: pkg.stringValue! };
  const vn = getAttr(root, 'versionName', ANDROID_NS, ID_VERSION_NAME);
  if (vn?.valueType === ValueType.String) info.versionName = vn.stringValue;
  const num = (x: AxmlAttribute | undefined): number | undefined =>
    x && (x.valueType === ValueType.IntDec || x.valueType === ValueType.IntHex) ? x.data >>> 0 : undefined;
  const vc = num(getAttr(root, 'versionCode', ANDROID_NS, ID_VERSION_CODE));
  if (vc !== undefined) info.versionCode = vc;
  const sdk = root.children.find((c) => c.name === 'uses-sdk');
  if (sdk) {
    const min = num(getAttr(sdk, 'minSdkVersion', ANDROID_NS, ID_MIN_SDK));
    const tgt = num(getAttr(sdk, 'targetSdkVersion', ANDROID_NS, ID_TARGET_SDK));
    if (min !== undefined) info.minSdk = min;
    if (tgt !== undefined) info.targetSdk = tgt;
  }
  return info;
}
