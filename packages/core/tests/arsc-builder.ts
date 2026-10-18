/** Synthetic resources.arsc builder for tests (independent of src/arsc, so the reader is not checked against itself). */
import { chunk, poolChunk, u16, u32, NONE } from './axml-builder';

export type BValue =
  | { str: string }
  | { type: number; data: number }
  | { complex: { name: number; type: number; data: number }[]; parent?: number };
export interface BEntry { key: string; value: BValue; flags?: number }
export interface BConfig {
  /** Raw config bytes; use cfg() to build one. */
  config: number[];
  entries: (BEntry | null)[];
  layout?: 'dense' | 'sparse' | 'offset16';
}
export interface BType { name: string; specFlags?: number[]; configs: BConfig[] }
export interface BPackage {
  id?: number;
  name?: string;
  types: BType[];
  /** Extra package children (raw chunks) appended at the end. */
  extra?: number[][];
  headerSize?: 284 | 288;
  typeIdOffset?: number;
  utf8?: boolean;
}
export interface BTable { strings?: string[]; utf8?: boolean; styles?: number; packages: BPackage[] }

/** ResTable_config of `size` bytes (28 default) with the given qualifiers. */
export function cfg(q: { density?: number; sdk?: number; mcc?: number; lang?: string; country?: string; orientation?: number; size?: number } = {}): number[] {
  const size = q.size ?? 28;
  const c = new Array<number>(size).fill(0);
  c.splice(0, 4, ...u32(size));
  c.splice(4, 2, ...u16(q.mcc ?? 0));
  if (q.lang) { c[8] = q.lang.charCodeAt(0); c[9] = q.lang.charCodeAt(1); }
  if (q.country) { c[10] = q.country.charCodeAt(0); c[11] = q.country.charCodeAt(1); }
  c[12] = q.orientation ?? 0;
  c.splice(14, 2, ...u16(q.density ?? 0));
  c.splice(24, 2, ...u16(q.sdk ?? 0));
  return c;
}

const val = (type: number, data: number): number[] => [...u16(8), 0, type, ...u32(data)];

export function buildArsc(t: BTable): Uint8Array {
  const strings = t.strings ?? [];
  const globalIdx = (s: string): number => {
    let i = strings.indexOf(s);
    if (i < 0) { strings.push(s); i = strings.length - 1; }
    return i;
  };
  const pkgs: number[][] = [];
  // intern file paths first so the global pool can be emitted before the packages
  for (const p of t.packages) for (const ty of p.types) for (const c of ty.configs) for (const e of c.entries) if (e && 'str' in e.value) globalIdx(e.value.str);
  for (const p of t.packages) {
    const keys: string[] = [];
    const keyIdx = (k: string): number => {
      let i = keys.indexOf(k);
      if (i < 0) { keys.push(k); i = keys.length - 1; }
      return i;
    };
    const chunks: number[][] = [];
    p.types.forEach((ty, ti) => {
      const id = ti + 1 + (p.typeIdOffset ?? 0);
      const count = Math.max(...ty.configs.map((c) => c.entries.length), ty.specFlags?.length ?? 0);
      const flags = ty.specFlags ?? new Array<number>(count).fill(0);
      chunks.push(chunk(0x0202, 16, [id, 0, ...u16(0), ...u32(flags.length), ...flags.flatMap(u32)]));
      for (const c of ty.configs) {
        const entryBytes = c.entries.map((e) => {
          if (!e) return null;
          if ('complex' in e.value) {
            const items = e.value.complex;
            return [...u16(16), ...u16((e.flags ?? 0) | 1), ...u32(keyIdx(e.key)), ...u32(e.value.parent ?? 0), ...u32(items.length),
              ...items.flatMap((i) => [...u32(i.name), ...val(i.type, i.data)])];
          }
          const v = 'str' in e.value ? val(3, globalIdx(e.value.str)) : val(e.value.type, e.value.data);
          return [...u16(8), ...u16(e.flags ?? 0), ...u32(keyIdx(e.key)), ...v];
        });
        const n = c.entries.length;
        const layout = c.layout ?? 'dense';
        let offsets: number[] = [];
        let body: number[] = [];
        let flag = 0;
        const cur = (): number => body.length;
        if (layout === 'dense') {
          offsets = entryBytes.flatMap((b) => { if (!b) return u32(NONE); const o = cur(); body = body.concat(b); return u32(o); });
        } else if (layout === 'offset16') {
          flag = 2;
          offsets = entryBytes.flatMap((b) => { if (!b) return u16(0xffff); const o = cur(); body = body.concat(b); return u16(o / 4); });
          if (n % 2) offsets.push(0, 0);
        } else {
          flag = 1;
          entryBytes.forEach((b, i) => { if (!b) return; const o = cur(); body = body.concat(b); offsets.push(...u16(i), ...u16(o / 4)); });
        }
        const hs = 20 + c.config.length;
        const count2 = layout === 'sparse' ? offsets.length / 4 : n;
        chunks.push(chunk(0x0201, hs, [id, flag, ...u16(0), ...u32(count2), ...u32(hs + offsets.length), ...c.config, ...offsets, ...body]));
        // entryCount in a sparse chunk is the number of present entries; the dense count is carried by the typeSpec
      }
    });
    const typePool = poolChunk(p.types.map((x) => x.name), p.utf8 ?? true);
    const keyPool = poolChunk(keys, p.utf8 ?? true);
    const hs = p.headerSize ?? 288;
    const nameUnits = Array.from({ length: 128 }, (_, i) => (p.name ?? 'com.test').charCodeAt(i) || 0);
    const head = [...u32(p.id ?? 0x7f), ...nameUnits.flatMap(u16), ...u32(hs), ...u32(p.types.length), ...u32(hs + typePool.length), ...u32(keys.length),
      ...(hs === 288 ? u32(p.typeIdOffset ?? 0) : [])];
    pkgs.push(chunk(0x0200, hs, [...head, ...typePool, ...keyPool, ...chunks.flat(), ...(p.extra ?? []).flat()]));
  }
  const global = poolChunk(strings, t.utf8 ?? true, t.styles ?? 0);
  return Uint8Array.from(chunk(0x0002, 12, [...u32(t.packages.length), ...global, ...pkgs.flat()]));
}
