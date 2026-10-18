/**
 * Generates a binary XML document from scratch (for small resource files such as an adaptive-icon definition).
 * Layout follows what aapt2 emits: UTF-8 string pool with attribute names that carry a resource id first, then the
 * resource-id map, then the namespace / element chunks; attributes are ordered by resource id as the runtime expects.
 */
import { StringPool } from '../arsc/pool';
import { ANDROID_NS, ValueType } from './axml';

export type AxmlBuildValue = { string: string } | { type: ValueType; data: number };
export interface AxmlBuildAttr {
  name: string;
  /** Namespace URI; defaults to the android namespace when `resourceId` is given. */
  nsUri?: string | null;
  /** Framework attribute id (e.g. 0x01010199 for android:drawable). */
  resourceId?: number;
  value: AxmlBuildValue;
}
export interface AxmlBuildElement {
  name: string;
  attrs?: AxmlBuildAttr[];
  children?: AxmlBuildElement[];
}
export interface AxmlBuildOptions {
  /** Namespace declarations placed before the root element. Default: `android` -> the Android namespace. */
  namespaces?: { prefix: string; uri: string }[];
}

const NONE = 0xffffffff;

/** Serializes `root` as a binary XML document. */
export function buildAxml(root: AxmlBuildElement, opts: AxmlBuildOptions = {}): Uint8Array {
  const namespaces = opts.namespaces ?? [{ prefix: 'android', uri: ANDROID_NS }];
  // attribute names with a resource id come first, in id order (the resource map is parallel to them)
  const idAttrs = new Map<number, string>();
  const collect = (e: AxmlBuildElement): void => {
    for (const a of e.attrs ?? []) if (a.resourceId !== undefined) idAttrs.set(a.resourceId, a.name);
    (e.children ?? []).forEach(collect);
  };
  collect(root);
  const ids = [...idAttrs.keys()].sort((a, b) => a - b);
  const pool = StringPool.create(true);
  // leading pool slots = id-bearing attribute names in id order, parallel to the resource map
  const names = ids.map((id) => idAttrs.get(id)!);
  if (new Set(names).size !== names.length) throw new Error('attribute names with resource ids must be unique');
  names.forEach((n) => pool.add(n));
  const S = (s: string): number => pool.add(s);

  const out: number[][] = [];
  let line = 1;
  const w32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const w16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
  const chunk = (type: number, hs: number, body: number[]): number[] => [...w16(type), ...w16(hs), ...w32(8 + body.length), ...body];
  const node = (type: number, words: number[]): number[] => chunk(type, 16, [...w32(line++), ...w32(NONE), ...words]);

  namespaces.forEach((n) => out.push(node(0x0100, [...w32(S(n.prefix)), ...w32(S(n.uri))])));
  const element = (e: AxmlBuildElement): void => {
    const attrs = [...(e.attrs ?? [])].sort((a, b) => (a.resourceId ?? Infinity) - (b.resourceId ?? Infinity));
    const bytes = attrs.flatMap((a) => {
      const ns = a.nsUri !== undefined ? a.nsUri : a.resourceId !== undefined ? ANDROID_NS : null;
      const nameIdx = a.resourceId !== undefined ? ids.indexOf(a.resourceId) : S(a.name);
      const strIdx = 'string' in a.value ? S(a.value.string) : NONE;
      const type = 'string' in a.value ? ValueType.String : a.value.type;
      const data = 'string' in a.value ? strIdx : a.value.data;
      return [...w32(ns === null ? NONE : S(ns)), ...w32(nameIdx), ...w32(strIdx), ...w16(8), 0, type, ...w32(data)];
    });
    const nameIdx = S(e.name);
    out.push(node(0x0102, [...w32(NONE), ...w32(nameIdx), ...w16(20), ...w16(20), ...w16(attrs.length), ...w16(0), ...w16(0), ...w16(0), ...bytes]));
    (e.children ?? []).forEach(element);
    out.push(node(0x0103, [...w32(NONE), ...w32(nameIdx)]));
  };
  element(root);
  [...namespaces].reverse().forEach((n) => out.push(node(0x0101, [...w32(S(n.prefix)), ...w32(S(n.uri))])));

  const poolBytes = Array.from(pool.serialize());
  const head: number[][] = [poolBytes];
  if (ids.length) head.push(chunk(0x0180, 8, ids.flatMap(w32)));
  const all = [...head, ...out].flat();
  return Uint8Array.from([...w16(0x0003), ...w16(8), ...w32(8 + all.length), ...all]);
}
