/**
 * resources.arsc reader / writer.
 *
 * The table is parsed into a model that keeps everything it does not understand as raw bytes: string pool entries,
 * entries and whole type chunks are re-emitted verbatim until a change touches them, so an unmodified table
 * serializes back byte-identically and resource ids of existing resources never move (new entries and new types
 * are always appended).
 *
 * Supported: global/type/key string pools (UTF-8 and UTF-16, styles preserved), several packages, typeSpec and type
 * chunks with any config (dense, sparse and 16-bit offset layouts are read; changed chunks are written dense),
 * simple and complex (bag) entries, unknown package children (library, overlayable, staged alias...) kept as raw chunks.
 * Limits: compact entries (Android 13+ size optimisation) are rejected with an ArscError instead of being rewritten;
 * only the package header fields up to typeIdOffset are kept; configs are compared by their qualifier bytes.
 */
import { configChangeFlags, configEquals } from './config';
import { ArscError, NONE, StringPool } from './pool';

export { ArscError } from './pool';

const T_TABLE = 0x0002, T_PACKAGE = 0x0200, T_TYPE = 0x0201, T_SPEC = 0x0202;
const ENTRY_COMPLEX = 0x1, ENTRY_COMPACT = 0x8;
const TYPE_SPARSE = 0x1, TYPE_OFFSET16 = 0x2;
const NO_ENTRY16 = 0xffff;

/** Res_value data types used by the helpers (same numbering as the binary XML value types). */
export const ResValue = { Reference: 0x01, String: 0x03, IntDec: 0x10, IntHex: 0x11, IntBoolean: 0x12, ColorArgb8: 0x1c, ColorRgb8: 0x1d } as const;

export interface ArscTypeSpec {
  /** One-based type id. */
  id: number;
  /** Per entry configuration-change flags (plus the "public" bit 0x40000000). */
  flags: number[];
  source?: Uint8Array;
}
export interface ArscTypeChunk {
  id: number;
  /** Raw ResTable_config bytes (at least the 4-byte size field). */
  config: Uint8Array;
  /** Raw entry bytes by entry index; undefined = no entry for this config. */
  entries: (Uint8Array | undefined)[];
  source?: Uint8Array;
}
export type ArscChunk =
  | { kind: 'spec'; spec: ArscTypeSpec }
  | { kind: 'type'; type: ArscTypeChunk }
  | { kind: 'other'; raw: Uint8Array };
export interface ArscPackage {
  id: number;
  name: string;
  /** Raw 128 UTF-16 code unit name field. */
  nameRaw: Uint8Array;
  headerSize: number;
  typeIdOffset: number;
  lastPublicType: number;
  lastPublicKey: number;
  typePool: StringPool;
  keyPool: StringPool;
  chunks: ArscChunk[];
}
export interface ArscTable {
  pool: StringPool;
  packages: ArscPackage[];
}

// ---------------------------------------------------------------------------------------------------------------
// Parse

function entryLength(b: Uint8Array, dv: DataView, o: number): number {
  if (o + 8 > b.length) throw new ArscError('entry out of range');
  const size = dv.getUint16(o, true);
  const flags = dv.getUint16(o + 2, true);
  if (flags & ENTRY_COMPACT) throw new ArscError('compact entries are not supported');
  if (flags & ENTRY_COMPLEX) {
    if (size < 16 || o + 16 > b.length) throw new ArscError('bad complex entry');
    return size + dv.getUint32(o + 12, true) * 12;
  }
  return size + 8;
}

function parseType(b: Uint8Array, dv: DataView, p: number, size: number, specCount: number): ArscTypeChunk {
  const hs = dv.getUint16(p + 2, true);
  const count = dv.getUint32(p + 12, true);
  const start = dv.getUint32(p + 16, true);
  const flags = b[p + 9]!;
  if (hs < 20 || hs + count * (flags & TYPE_OFFSET16 ? 2 : 4) > size || start > size) throw new ArscError('bad type chunk');
  // a sparse chunk counts only its present entries; the full entry count comes from the typeSpec
  const total = flags & TYPE_SPARSE ? Math.max(count, specCount) : count;
  const entries: (Uint8Array | undefined)[] = new Array<Uint8Array | undefined>(total).fill(undefined);
  const take = (idx: number, off: number): void => {
    if (idx >= total) throw new ArscError('sparse entry index out of range');
    const o = p + start + off;
    const len = entryLength(b, dv, o);
    if (o + len > p + size) throw new ArscError('entry out of range');
    entries[idx] = b.slice(o, o + len);
  };
  for (let i = 0; i < count; i++) {
    if (flags & TYPE_SPARSE) {
      const v = dv.getUint32(p + hs + i * 4, true);
      take(v & 0xffff, (v >>> 16) * 4);
    } else if (flags & TYPE_OFFSET16) {
      const v = dv.getUint16(p + hs + i * 2, true);
      if (v !== NO_ENTRY16) take(i, v * 4);
    } else {
      const v = dv.getUint32(p + hs + i * 4, true);
      if (v !== NONE) take(i, v);
    }
  }
  return { id: b[p + 8]!, config: b.slice(p + 20, p + hs), entries, source: b.slice(p, p + size) };
}

function parsePackage(b: Uint8Array, dv: DataView, off: number, size: number): ArscPackage {
  const hs = dv.getUint16(off + 2, true);
  if (hs < 284 || hs > size) throw new ArscError('bad package header');
  const end = off + size;
  const typeStrings = dv.getUint32(off + 268, true);
  const keyStrings = dv.getUint32(off + 276, true);
  const typePool = StringPool.parse(b, off + typeStrings);
  const keyPool = StringPool.parse(b, off + keyStrings);
  const nameRaw = b.slice(off + 12, off + 12 + 256);
  let name = '';
  for (let i = 0; i < 128; i++) {
    const c = dv.getUint16(off + 12 + i * 2, true);
    if (!c) break;
    name += String.fromCharCode(c);
  }
  const chunks: ArscChunk[] = [];
  const specCounts = new Map<number, number>();
  let p = off + Math.max(hs, typeStrings + typePool.size, keyStrings + keyPool.size);
  while (p < end) {
    if (p + 8 > end) throw new ArscError('truncated package chunk');
    const type = dv.getUint16(p, true);
    const csize = dv.getUint32(p + 4, true);
    if (csize < 8 || p + csize > end) throw new ArscError('bad chunk size in package');
    if (type === T_SPEC) {
      const count = dv.getUint32(p + 12, true);
      if (dv.getUint16(p + 2, true) + count * 4 > csize) throw new ArscError('bad typeSpec chunk');
      const flags: number[] = [];
      for (let i = 0; i < count; i++) flags.push(dv.getUint32(p + 16 + i * 4, true));
      specCounts.set(b[p + 8]!, count);
      chunks.push({ kind: 'spec', spec: { id: b[p + 8]!, flags, source: b.slice(p, p + csize) } });
    } else if (type === T_TYPE) chunks.push({ kind: 'type', type: parseType(b, dv, p, csize, specCounts.get(b[p + 8]!) ?? 0) });
    else chunks.push({ kind: 'other', raw: b.slice(p, p + csize) });
    p += csize;
  }
  return {
    id: dv.getUint32(off + 8, true), name, nameRaw, headerSize: hs >= 288 ? 288 : 284,
    typeIdOffset: hs >= 288 ? dv.getUint32(off + 284, true) : 0,
    lastPublicType: dv.getUint32(off + 272, true), lastPublicKey: dv.getUint32(off + 280, true),
    typePool: typePool.pool, keyPool: keyPool.pool, chunks,
  };
}

export function parseArsc(bytes: Uint8Array): ArscTable {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || dv.getUint16(0, true) !== T_TABLE) throw new ArscError('not a resource table');
  const hs = dv.getUint16(2, true);
  const total = dv.getUint32(4, true);
  if (hs < 12 || total > bytes.length || total < hs) throw new ArscError('bad resource table header');
  const pkgCount = dv.getUint32(8, true);
  const { pool, size } = StringPool.parse(bytes, hs);
  const packages: ArscPackage[] = [];
  let p = hs + size;
  while (p < total) {
    if (p + 8 > total) throw new ArscError('truncated table chunk');
    const type = dv.getUint16(p, true);
    const csize = dv.getUint32(p + 4, true);
    if (type !== T_PACKAGE || csize < 8 || p + csize > total) throw new ArscError('unexpected chunk in resource table');
    packages.push(parsePackage(bytes, dv, p, csize));
    p += csize;
  }
  if (packages.length !== pkgCount) throw new ArscError(`package count mismatch (${packages.length} vs ${pkgCount})`);
  return { pool, packages };
}

// ---------------------------------------------------------------------------------------------------------------
// Serialize

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let w = 0;
  for (const x of parts) { out.set(x, w); w += x.length; }
  return out;
}

function serializeSpec(s: ArscTypeSpec): Uint8Array {
  if (s.source) return s.source;
  const out = new Uint8Array(16 + s.flags.length * 4);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, T_SPEC, true);
  dv.setUint16(2, 16, true);
  dv.setUint32(4, out.length, true);
  out[8] = s.id;
  dv.setUint32(12, s.flags.length, true);
  s.flags.forEach((f, i) => dv.setUint32(16 + i * 4, f, true));
  return out;
}

function serializeType(t: ArscTypeChunk): Uint8Array {
  if (t.source) return t.source;
  const n = t.entries.length;
  const hs = 20 + t.config.length;
  const start = hs + n * 4;
  let body = 0;
  for (const e of t.entries) body += e?.length ?? 0;
  const out = new Uint8Array(start + body);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, T_TYPE, true);
  dv.setUint16(2, hs, true);
  dv.setUint32(4, out.length, true);
  out[8] = t.id;
  dv.setUint32(12, n, true);
  dv.setUint32(16, start, true);
  out.set(t.config, 20);
  let w = start;
  t.entries.forEach((e, i) => {
    if (!e) { dv.setUint32(hs + i * 4, NONE, true); return; }
    dv.setUint32(hs + i * 4, w - start, true);
    out.set(e, w);
    w += e.length;
  });
  return out;
}

function serializePackage(p: ArscPackage): Uint8Array {
  const tp = p.typePool.serialize(), kp = p.keyPool.serialize();
  const head = new Uint8Array(p.headerSize);
  const dv = new DataView(head.buffer);
  const body = p.chunks.map((c) => (c.kind === 'spec' ? serializeSpec(c.spec) : c.kind === 'type' ? serializeType(c.type) : c.raw));
  dv.setUint16(0, T_PACKAGE, true);
  dv.setUint16(2, p.headerSize, true);
  dv.setUint32(4, p.headerSize + tp.length + kp.length + body.reduce((n, x) => n + x.length, 0), true);
  dv.setUint32(8, p.id, true);
  head.set(p.nameRaw, 12);
  dv.setUint32(268, p.headerSize, true);
  dv.setUint32(272, p.lastPublicType, true);
  dv.setUint32(276, p.headerSize + tp.length, true);
  dv.setUint32(280, p.lastPublicKey, true);
  if (p.headerSize >= 288) dv.setUint32(284, p.typeIdOffset, true);
  return concat([head, tp, kp, ...body]);
}

export function serializeArsc(t: ArscTable): Uint8Array {
  const pool = t.pool.serialize();
  const pkgs = t.packages.map(serializePackage);
  const head = new Uint8Array(12);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, T_TABLE, true);
  dv.setUint16(2, 12, true);
  dv.setUint32(4, 12 + pool.length + pkgs.reduce((n, x) => n + x.length, 0), true);
  dv.setUint32(8, pkgs.length, true);
  return concat([head, pool, ...pkgs]);
}

// ---------------------------------------------------------------------------------------------------------------
// Lookup

export const resourceId = (packageId: number, typeId: number, entry: number): number => ((packageId << 24) | (typeId << 16) | entry) >>> 0;

export function findPackage(t: ArscTable, packageId?: number): ArscPackage {
  const p = packageId === undefined ? t.packages[0] : t.packages.find((x) => x.id === packageId);
  if (!p) throw new ArscError(packageId === undefined ? 'resource table has no package' : `no package 0x${packageId.toString(16)}`);
  return p;
}

/** One-based type id for a type name, or undefined when the package has no such type name. */
export function findTypeId(pkg: ArscPackage, typeName: string): number | undefined {
  const i = pkg.typePool.indexOf(typeName);
  return i < 0 ? undefined : i + 1 + pkg.typeIdOffset;
}
export function typeNameOf(pkg: ArscPackage, typeId: number): string {
  return pkg.typePool.get(typeId - 1 - pkg.typeIdOffset);
}

const specOf = (pkg: ArscPackage, typeId: number): ArscTypeSpec | undefined => {
  for (const c of pkg.chunks) if (c.kind === 'spec' && c.spec.id === typeId) return c.spec;
  return undefined;
};
const typeChunksOf = (pkg: ArscPackage, typeId: number): ArscTypeChunk[] =>
  pkg.chunks.flatMap((c) => (c.kind === 'type' && c.type.id === typeId ? [c.type] : []));

const entryKey = (e: Uint8Array): number => new DataView(e.buffer, e.byteOffset, e.byteLength).getUint32(4, true);

/** Resource id of `type/name` (e.g. `drawable`, `icon`), or undefined. */
export function findResource(t: ArscTable, typeName: string, name: string, packageId?: number): number | undefined {
  const pkg = findPackage(t, packageId);
  const typeId = findTypeId(pkg, typeName);
  const key = pkg.keyPool.indexOf(name);
  if (typeId === undefined || key < 0) return undefined;
  for (const tc of typeChunksOf(pkg, typeId)) {
    const i = tc.entries.findIndex((e) => e !== undefined && entryKey(e) === key);
    if (i >= 0) return resourceId(pkg.id, typeId, i);
  }
  return undefined;
}

export type EntryValue =
  | { kind: 'value'; dataType: number; data: number; flags?: number }
  | { kind: 'string'; value: string; flags?: number }
  | { kind: 'complex'; parent: number; items: { name: number; dataType: number; data: number }[]; flags?: number };

export type DecodedEntry =
  | { kind: 'value'; key: string; flags: number; dataType: number; data: number; string?: string }
  | { kind: 'complex'; key: string; flags: number; parent: number; items: { name: number; dataType: number; data: number }[] };

export function decodeEntry(t: ArscTable, pkg: ArscPackage, raw: Uint8Array): DecodedEntry {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const size = dv.getUint16(0, true), flags = dv.getUint16(2, true);
  const key = pkg.keyPool.get(dv.getUint32(4, true));
  if (flags & ENTRY_COMPLEX) {
    const items = [];
    for (let i = 0; i < dv.getUint32(12, true); i++) {
      const o = size + i * 12;
      items.push({ name: dv.getUint32(o, true), dataType: raw[o + 7]!, data: dv.getUint32(o + 8, true) });
    }
    return { kind: 'complex', key, flags, parent: dv.getUint32(8, true), items };
  }
  const dataType = raw[size + 3]!, data = dv.getUint32(size + 4, true);
  return dataType === 0x03 ? { kind: 'value', key, flags, dataType, data, string: t.pool.get(data) } : { kind: 'value', key, flags, dataType, data };
}

export interface ResourceInfo {
  type: string;
  name: string;
  configs: { config: Uint8Array; entry: DecodedEntry }[];
}

/** Name and every configuration of a resource id. */
export function getResource(t: ArscTable, id: number): ResourceInfo | undefined {
  const pkg = t.packages.find((p) => p.id === id >>> 24);
  if (!pkg) return undefined;
  const typeId = (id >>> 16) & 0xff, index = id & 0xffff;
  const configs = typeChunksOf(pkg, typeId).flatMap((tc) => {
    const raw = tc.entries[index];
    return raw ? [{ config: tc.config, entry: decodeEntry(t, pkg, raw) }] : [];
  });
  if (configs.length === 0) return undefined;
  return { type: typeNameOf(pkg, typeId), name: configs[0]!.entry.key, configs };
}

// ---------------------------------------------------------------------------------------------------------------
// Modification

function encodeEntryValue(t: ArscTable, pkg: ArscPackage, name: string, v: EntryValue): Uint8Array {
  const keyIdx = pkg.keyPool.add(name);
  const flags = v.flags ?? 0;
  if (v.kind === 'complex') {
    const out = new Uint8Array(16 + v.items.length * 12);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, 16, true);
    dv.setUint16(2, flags | ENTRY_COMPLEX, true);
    dv.setUint32(4, keyIdx, true);
    dv.setUint32(8, v.parent, true);
    dv.setUint32(12, v.items.length, true);
    v.items.forEach((it, i) => {
      const o = 16 + i * 12;
      dv.setUint32(o, it.name, true);
      dv.setUint16(o + 4, 8, true);
      out[o + 7] = it.dataType;
      dv.setUint32(o + 8, it.data, true);
    });
    return out;
  }
  const dataType = v.kind === 'string' ? ResValue.String : v.dataType;
  const data = v.kind === 'string' ? t.pool.add(v.value) : v.data;
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 8, true);
  dv.setUint16(2, flags, true);
  dv.setUint32(4, keyIdx, true);
  dv.setUint16(8, 8, true);
  out[11] = dataType;
  dv.setUint32(12, data, true);
  return out;
}

function checkConfig(config: Uint8Array): void {
  if (config.length < 28 || config.length % 4 !== 0) throw new ArscError('config must be at least 28 bytes and a multiple of 4');
}

/** Stores `value` for entry `index` under `config`, creating the type chunk of that config when needed. */
function setConfigEntry(t: ArscTable, pkg: ArscPackage, typeId: number, spec: ArscTypeSpec, index: number, name: string, config: Uint8Array, value: EntryValue): void {
  checkConfig(config);
  let tc = typeChunksOf(pkg, typeId).find((c) => configEquals(c.config, config));
  if (!tc) {
    tc = { id: typeId, config: config.slice(), entries: new Array<Uint8Array | undefined>(spec.flags.length).fill(undefined) };
    let at = pkg.chunks.length;
    pkg.chunks.forEach((c, i) => {
      if ((c.kind === 'spec' && c.spec.id === typeId) || (c.kind === 'type' && c.type.id === typeId)) at = i + 1;
    });
    pkg.chunks.splice(at, 0, { kind: 'type', type: tc });
  }
  if (tc.entries[index]) throw new ArscError(`resource already has an entry for this config`);
  tc.entries[index] = encodeEntryValue(t, pkg, name, value);
  delete tc.source;
  spec.flags[index] = (spec.flags[index]! | configChangeFlags(config)) >>> 0;
  delete spec.source;
}

export interface NewResource {
  /** Type name, e.g. `mipmap`; the type is created when the package does not have it. */
  type: string;
  name: string;
  configs: { config: Uint8Array; value: EntryValue }[];
  packageId?: number;
}

/** Appends a new resource (and its type when missing). Returns its id; ids of existing resources do not change. */
export function addResource(t: ArscTable, r: NewResource): number {
  if (r.configs.length === 0) throw new ArscError('a resource needs at least one configuration');
  r.configs.forEach((c) => checkConfig(c.config));
  const pkg = findPackage(t, r.packageId);
  let typeId = findTypeId(pkg, r.type);
  if (typeId === undefined) {
    typeId = pkg.typePool.add(r.type) + 1 + pkg.typeIdOffset;
    if (typeId > 0xff) throw new ArscError('too many resource types');
  }
  if (findResource(t, r.type, r.name, pkg.id) !== undefined) throw new ArscError(`resource ${r.type}/${r.name} already exists`);
  let spec = specOf(pkg, typeId);
  if (!spec) {
    spec = { id: typeId, flags: [] };
    pkg.chunks.push({ kind: 'spec', spec });
  }
  const index = spec.flags.length;
  if (index > 0xffff) throw new ArscError('too many entries in type');
  spec.flags.push(0);
  delete spec.source;
  for (const tc of typeChunksOf(pkg, typeId)) {
    while (tc.entries.length <= index) tc.entries.push(undefined);
    delete tc.source;
  }
  for (const c of r.configs) setConfigEntry(t, pkg, typeId, spec, index, r.name, c.config, c.value);
  return resourceId(pkg.id, typeId, index);
}

/** Adds one more configuration (e.g. `anydpi-v26`) to an existing resource. */
export function addConfig(t: ArscTable, id: number, config: Uint8Array, value: EntryValue): void {
  const info = getResource(t, id);
  if (!info) throw new ArscError(`no resource 0x${id.toString(16)}`);
  const pkg = findPackage(t, id >>> 24);
  const typeId = (id >>> 16) & 0xff;
  setConfigEntry(t, pkg, typeId, specOf(pkg, typeId)!, id & 0xffff, info.name, config, value);
}
