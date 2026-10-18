import { describe, it, expect } from 'vitest';
import {
  parseAxml, serializeAxml, insertElement, removeElement, removeAttr, declareNamespace, getAttr, findElements,
  ValueType, ANDROID_NS, AxmlError,
} from '../src/axml';
import { build, dump, type BEl, type BuildOptions } from './axml-builder';

const NAME = 0x01010003, SCHEME = 0x01010027, EXPORTED = 0x01010010;
const base = (): BEl => ({
  name: 'manifest',
  attrs: [{ name: 'package', str: 'p.q' }],
  children: [{
    name: 'application',
    children: [
      { name: 'activity', attrs: [{ name: 'name', res: NAME, str: 'A' }], children: [{ name: 'intent-filter' }] },
      { name: 'activity', attrs: [{ name: 'name', res: NAME, str: 'B' }] },
    ],
  }],
});
const load = (r: BEl = base(), o: BuildOptions = {}) => parseAxml(build(r, o));
const roundTrip = (d: ReturnType<typeof load>) => parseAxml(serializeAxml(d));
const el = (d: ReturnType<typeof load>, tag: string, i = 0) => findElements(d, (e) => e.name === tag)[i]!;
const FILTER = {
  name: 'intent-filter',
  attributes: [{ name: 'priority', nsUri: ANDROID_NS, resourceId: 0x0101001c, valueType: ValueType.IntDec, data: 5 }],
  children: [
    { name: 'action', attributes: [{ name: 'name', nsUri: ANDROID_NS, resourceId: NAME, value: 'android.intent.action.VIEW' }] },
    { name: 'data', attributes: [{ name: 'scheme', nsUri: ANDROID_NS, resourceId: SCHEME, value: 'blockheads' }] },
  ],
};

describe('insertElement', () => {
  for (const utf8 of [true, false]) {
    it(`inserts a subtree (${utf8 ? 'utf8' : 'utf16'}) that survives serialization and matches a decoded dump`, () => {
      const d = load(base(), { utf8 });
      const act = el(d, 'activity');
      const f = insertElement(d, act, FILTER, 0);
      expect(act.children[0]).toBe(f);
      expect(f.children.map((c) => c.name)).toEqual(['action', 'data']);
      const bytes = serializeAxml(d);
      const lines = dump(bytes);
      expect(lines.filter((l) => l.startsWith('el intent-filter') || l.startsWith('el -:intent-filter')).length).toBe(2);
      expect(lines.some((l) => l.includes('scheme[1010027]raw=blockheads/3:blockheads'))).toBe(true);
      expect(lines.some((l) => l.includes('priority[101001c]raw=-/16:5'))).toBe(true);
      const again = parseAxml(bytes);
      const f2 = el(again, 'activity').children[0]!;
      expect(getAttr(f2.children[1]!, 'scheme', ANDROID_NS, SCHEME)?.stringValue).toBe('blockheads');
      expect(getAttr(f2, 'priority', ANDROID_NS, 0x0101001c)?.data).toBe(5);
      expect(el(again, 'activity').children[1]!.name).toBe('intent-filter');
      // existing values untouched after resource-map growth
      expect(getAttr(el(again, 'activity', 1), 'name', ANDROID_NS, NAME)?.stringValue).toBe('B');
      expect(serializeAxml(again)).toEqual(bytes);
    });
  }

  it('appends by default, assigns increasing line numbers and balanced end lines', () => {
    const d = load();
    const app = el(d, 'application');
    const n = insertElement(d, app, { name: 'service', children: [{ name: 'x' }] });
    expect(app.children[2]).toBe(n);
    const lines = findElements(d, () => true).map((e) => e.lineNumber);
    expect(new Set(lines).size).toBe(lines.length);
    const again = roundTrip(d);
    expect(el(again, 'service').children[0]!.name).toBe('x');
    expect(Math.max(...findElements(again, () => true).map((e) => e.lineNumber))).toBeLessThan(1000);
  });

  it('supports element namespaces, plain-int attributes and attributes without resource ids', () => {
    const d = load();
    const e = insertElement(d, el(d, 'application'), {
      name: 'x', nsUri: ANDROID_NS,
      attributes: [{ name: 'plain', value: 'v' }, { name: 'n' }, { name: 'ns', nsUri: ANDROID_NS, value: 'w' }],
    });
    const again = roundTrip(d);
    const x = el(again, 'x');
    expect(x.nsUri).toBe(ANDROID_NS);
    expect(getAttr(x, 'plain')?.stringValue).toBe('v');
    expect(getAttr(x, 'n')?.data).toBe(0);
    expect(getAttr(x, 'n')?.valueType).toBe(ValueType.IntDec);
    expect(e.attributes.length).toBe(3);
  });

  it('works on documents without a resource map', () => {
    const d = load({ name: 'r' }, { ns: false });
    insertElement(d, d.root, { name: 'c', attributes: [{ name: 'a', value: 'b' }] });
    expect(roundTrip(d).root.children[0]!.attributes[0]!.stringValue).toBe('b');
  });

  it('creates a resource map when the first resource-id attribute is added', () => {
    const d = load({ name: 'r' }, { ns: false });
    declareNamespace(d, 'android', ANDROID_NS);
    insertElement(d, d.root, { name: 'c', attributes: [{ name: 'name', nsUri: ANDROID_NS, resourceId: NAME, value: 'z' }] });
    const again = roundTrip(d);
    expect(getAttr(again.root.children[0]!, 'name', ANDROID_NS, NAME)?.stringValue).toBe('z');
  });

  it('rejects bad indices, foreign parents and undeclared namespaces', () => {
    const d = load();
    const app = el(d, 'application');
    expect(() => insertElement(d, app, { name: 'x' }, -1)).toThrow(AxmlError);
    expect(() => insertElement(d, app, { name: 'x' }, 3)).toThrow(/out of range/);
    expect(() => insertElement(d, app, { name: 'x' }, 0.5)).toThrow(AxmlError);
    expect(() => insertElement(d, { name: 'q', nsUri: null, attributes: [], children: [], lineNumber: 0 }, { name: 'x' })).toThrow(/unknown element/);
    const bare = load({ name: 'r' }, { ns: false });
    expect(() => insertElement(bare, bare.root, { name: 'x', nsUri: 'urn:none' })).toThrow(/not declared/);
    expect(() => insertElement(bare, bare.root, { name: 'x', attributes: [{ name: 'a', nsUri: 'urn:none', value: '1' }] })).toThrow(/not declared/);
    expect(() => insertElement(bare, bare.root, { name: 'x', children: [{ name: 'y', nsUri: 'urn:none' }] })).toThrow(/not declared/);
    expect(bare.root.children.length).toBe(0);
    expect(() => insertElement({ root: d.root }, app, { name: 'x' })).toThrow(/not created/);
  });

  it('keeps text-node positions: text before the insertion point stays before the old child', () => {
    const r: BEl = { name: 'r', children: [{ name: 'a' }, { name: 'b' }], texts: [{ pos: 0, value: 'T0' }, { pos: 1, value: 'T1' }, { pos: 2, value: 'T2' }] };
    const d = load(r);
    insertElement(d, d.root, { name: 'n' }, 1);
    const lines = dump(serializeAxml(d)).filter((l) => l.startsWith('text') || /^el -?:?[a-z]/.test(l) && !l.startsWith('el -:r'));
    const seq = lines.map((l) => l.replace(/ .*/, '') === 'text' ? l.split(' ')[1] : l.split(' ')[1]!.split(':')[1]);
    expect(seq).toEqual(['T0', 'a', 'n', 'T1', 'b', 'T2']);
  });
});

describe('removeElement / removeAttr', () => {
  it('removes a child with its subtree and shifts later text nodes', () => {
    const r: BEl = { name: 'r', children: [{ name: 'a', children: [{ name: 'deep' }] }, { name: 'b' }, { name: 'c' }], texts: [{ pos: 0, value: 'T0' }, { pos: 1, value: 'T1' }, { pos: 3, value: 'T3' }] };
    const d = load(r);
    removeElement(d, d.root, d.root.children[0]!);
    const again = roundTrip(d);
    expect(again.root.children.map((c) => c.name)).toEqual(['b', 'c']);
    const lines = dump(serializeAxml(d));
    expect(lines.some((l) => l.includes(':deep'))).toBe(false);
    const texts = lines.filter((l) => l.startsWith('text')).map((l) => l.split(' ')[1]);
    expect(texts).toEqual(['T0', 'T1', 'T3']);
    expect(lines.findIndex((l) => l.startsWith('text T3'))).toBeGreaterThan(lines.findIndex((l) => l.includes(':c')));
  });

  it('rejects non-children and foreign parents', () => {
    const d = load();
    const [a, b] = [el(d, 'activity', 0), el(d, 'activity', 1)];
    expect(() => removeElement(d, a, b)).toThrow(/not a child/);
    expect(() => removeElement(d, { name: 'q', nsUri: null, attributes: [], children: [], lineNumber: 0 }, b)).toThrow(/unknown element/);
    expect(() => removeElement({ root: d.root }, a, b)).toThrow(/not created/);
  });

  it('removes attributes and fixes the id/class/style attribute indices', () => {
    const mk = (idIndex: number) => load({
      name: 'r', idIndex,
      attrs: [{ name: 'a', res: 0x01010001, str: 'x' }, { name: 'b', res: 0x01010002, str: 'y' }, { name: 'c', res: 0x01010003, str: 'z' }],
    });
    const idxOf = (d: ReturnType<typeof load>) => new DataView(serializeAxml(d).buffer).getUint16(0, true) && dump(serializeAxml(d)).find((l) => l.startsWith('el '))!;
    // idIndex 2 (attribute b): removing the earlier attribute decrements it, removing b clears it, removing a later one keeps it
    let d = mk(2);
    removeAttr(d, d.root, d.root.attributes[0]!);
    expect(idxOf(d)).toContain('id=1');
    d = mk(2);
    removeAttr(d, d.root, d.root.attributes[1]!);
    expect(idxOf(d)).toContain('id=0');
    d = mk(2);
    removeAttr(d, d.root, d.root.attributes[2]!);
    expect(idxOf(d)).toContain('id=2');
    expect(roundTrip(d).root.attributes.length).toBe(2);
  });

  it('rejects unknown attributes and elements', () => {
    const d = load();
    const a = el(d, 'activity');
    const other = el(d, 'activity', 1).attributes[0]!;
    expect(() => removeAttr(d, a, other)).toThrow(/does not belong/);
    expect(() => removeAttr(d, { name: 'q', nsUri: null, attributes: [], children: [], lineNumber: 0 }, other)).toThrow(/unknown element/);
    expect(() => removeAttr({ root: d.root }, a, other)).toThrow(/not created/);
  });
});

describe('declareNamespace', () => {
  it('adds a missing declaration once and serializes balanced start/end nodes', () => {
    const d = load({ name: 'r' }, { ns: false });
    expect(declareNamespace(d, 'tools', 'http://schemas.android.com/tools')).toBe(true);
    expect(declareNamespace(d, 'tools', 'http://schemas.android.com/tools')).toBe(false);
    insertElement(d, d.root, { name: 'c', attributes: [{ name: 'node', nsUri: 'http://schemas.android.com/tools', value: 'remove' }] });
    const lines = dump(serializeAxml(d));
    expect(lines.filter((l) => l.startsWith('ns ')).length).toBe(1);
    expect(lines.filter((l) => l.startsWith('/ns ')).length).toBe(1);
    expect(roundTrip(d).root.children[0]!.attributes[0]!.nsUri).toBe('http://schemas.android.com/tools');
  });

  it('is a no-op for already declared namespaces and rejects foreign documents', () => {
    const d = load();
    expect(declareNamespace(d, 'android', ANDROID_NS)).toBe(false);
    expect(() => declareNamespace({ root: d.root }, 'x', 'y')).toThrow(/not created/);
  });

  it('inserts after a resource map without disturbing resource-id names', () => {
    const d = load();
    declareNamespace(d, 'app', 'http://schemas.android.com/apk/res-auto');
    const act = el(d, 'activity');
    insertElement(d, act, { name: 'meta-data', attributes: [{ name: 'name', nsUri: ANDROID_NS, resourceId: NAME, value: 'k' }, { name: 'exported', nsUri: ANDROID_NS, resourceId: EXPORTED, valueType: ValueType.IntBoolean, data: 0xffffffff }] });
    const again = roundTrip(d);
    const m = el(again, 'meta-data');
    expect(getAttr(m, 'exported', ANDROID_NS, EXPORTED)?.data).toBe(0xffffffff);
    expect(getAttr(el(again, 'activity'), 'name', ANDROID_NS, NAME)?.stringValue).toBe('A');
  });
});
