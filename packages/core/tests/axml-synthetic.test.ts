import { describe, it, expect } from 'vitest';
import {
  parseAxml, serializeAxml, findElements, findElementsByName, getAttr, setAttrValue, setAttrString, addAttr, manifestInfo,
  ValueType, ANDROID_NS, AxmlError, type AxmlDocument, type AxmlElement, type AxmlAttribute,
} from '../src/axml';
import { build, dump, chunk, poolChunk, xmlFile, u16, u32, NONE, T, type BEl, type BuildOptions } from './axml-builder';

const ACTIVITY = 'com.noodlecake.noodlewebview.BlockheadsWebView';
const RID = { versionCode: 0x0101021b, versionName: 0x0101021c, minSdk: 0x0101020c, targetSdk: 0x01010270, name: 0x01010003, theme: 0x01010000, label: 0x01010001 };

function manifest(): BEl {
  return {
    name: 'manifest',
    attrs: [
      { name: 'versionCode', res: RID.versionCode, type: 0x10, data: 1548230154 },
      { name: 'versionName', res: RID.versionName, str: '1.7.4' },
      { name: 'package', str: 'com.noodlecake.blockheads' },
    ],
    children: [
      { name: 'uses-sdk', attrs: [{ name: 'minSdkVersion', res: RID.minSdk, type: 0x10, data: 16 }, { name: 'targetSdkVersion', res: RID.targetSdk, type: 0x10, data: 30 }] },
      {
        name: 'application',
        children: [
          { name: 'activity', attrs: [{ name: 'name', res: RID.name, str: ACTIVITY }, { name: 'theme', res: RID.theme, type: 0x01, data: 0x01030005 }] },
          { name: 'activity', attrs: [{ name: 'name', res: RID.name, str: '.Other' }] },
        ],
      },
    ],
  };
}
const parse = (root: BEl, o?: BuildOptions) => parseAxml(build(root, o));
const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('axml round trip (synthetic fixtures)', () => {
  const variants: [string, BEl, BuildOptions][] = [
    ['utf8 manifest', manifest(), {}],
    ['utf16 manifest', manifest(), { utf8: false }],
    ['no namespace, no resource map', { name: 'root', attrs: [{ name: 'a', str: 'x' }, { name: 'n', type: 0x10, data: 7, raw: '7' }] }, { ns: false }],
    ['style entries', manifest(), { styles: 2 }],
    ['utf8 long strings', { name: 'r', attrs: [{ name: 'a', str: 'é'.repeat(200) }, { name: 'b', str: 'z'.repeat(300) }] }, { utf8: true }],
    ['utf16 long string (4 byte header)', { name: 'r', attrs: [{ name: 'a', str: 'q'.repeat(40000) }] }, { utf8: false }],
    ['text nodes everywhere', {
      name: 'r',
      children: [{ name: 'c1' }, { name: 'c2', texts: [{ pos: 0, value: 'inner' }] }],
      texts: [{ pos: 0, value: 'first' }, { pos: 1, value: 'mid', typedString: true }, { pos: 2, value: 'last' }],
    }, { before: ['pre'], after: ['post'] }],
    ['trailing bytes', manifest(), { trailing: [1, 2, 3, 4] }],
  ];
  for (const [name, root, opts] of variants) {
    it(`${name}: parse -> serialize is byte-identical`, () => {
      const bytes = build(root, opts);
      expect(hexOf(serializeAxml(parseAxml(bytes)))).toBe(hexOf(bytes));
    });
  }

  it('exposes the tree: names, namespaces, resource ids, values, line numbers', () => {
    const doc = parse(manifest());
    expect(doc.root.name).toBe('manifest');
    expect(doc.root.nsUri).toBeNull();
    expect(doc.root.lineNumber).toBeGreaterThan(0);
    const act = findElementsByName(doc, 'activity', ACTIVITY);
    expect(act).toHaveLength(1);
    const theme = getAttr(act[0]!, 'theme', ANDROID_NS, RID.theme)!;
    expect(theme).toMatchObject({ nsUri: ANDROID_NS, resourceId: RID.theme, valueType: ValueType.Reference, data: 0x01030005 });
    const pkg = getAttr(doc.root, 'package', null)!;
    expect(pkg).toMatchObject({ resourceId: null, stringValue: 'com.noodlecake.blockheads', rawValue: 'com.noodlecake.blockheads' });
  });

  it('falls back to empty names / string values for NONE string references', () => {
    const pool = poolChunk(['x'], true);
    const attrBytes = [...u32(NONE), ...u32(NONE), ...u32(NONE), ...u16(8), 0, 3, ...u32(NONE)];
    const el = chunk(T.START_EL, 16, [...u32(1), ...u32(NONE), ...u32(NONE), ...u32(NONE), ...u16(20), ...u16(20), ...u16(1), ...u16(0), ...u16(0), ...u16(0), ...attrBytes]);
    const end = chunk(T.END_EL, 16, [...u32(1), ...u32(NONE), ...u32(NONE), ...u32(NONE)]);
    const doc = parseAxml(xmlFile([pool, el, end]));
    expect(doc.root.name).toBe('');
    expect(doc.root.attributes[0]).toMatchObject({ name: '', stringValue: '', rawValue: null, nsUri: null });
    expect(hexOf(serializeAxml(doc))).toBe(hexOf(xmlFile([pool, el, end])));
  });
});

describe('documents without a resource map', () => {
  const plain = (): BEl => ({ name: 'r', attrs: [{ name: 'a', str: 'old' }] });

  it('round-trips a pool with no strings at all', () => {
    const el = chunk(T.START_EL, 16, [...u32(1), ...u32(NONE), ...u32(NONE), ...u32(NONE), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0)]);
    const end = chunk(T.END_EL, 16, [...u32(1), ...u32(NONE), ...u32(NONE), ...u32(NONE)]);
    const bytes = xmlFile([poolChunk([], true), el, end]);
    const doc = parseAxml(bytes);
    expect(doc.root.name).toBe('');
    expect(hexOf(serializeAxml(doc))).toBe(hexOf(bytes));
  });

  it('setAttrString interns from the start of the pool', () => {
    const doc = parse(plain());
    setAttrString(doc, doc.root.attributes[0]!, 'new');
    setAttrString(doc, doc.root.attributes[0]!, 'r'); // existing pool entry (the element name)
    expect(parseAxml(serializeAxml(doc)).root.attributes[0]!.stringValue).toBe('r');
  });

  it('addAttr without a resource id works with any value type', () => {
    const doc = parse(plain());
    addAttr(doc, doc.root, { nsUri: null, name: 'n1', resourceId: null, rawValue: 'str', valueType: ValueType.String, data: 0 });
    addAttr(doc, doc.root, { nsUri: null, name: 'n2', resourceId: null, rawValue: '5', valueType: ValueType.IntDec, data: 5 });
    addAttr(doc, doc.root, { nsUri: null, name: 'n3', resourceId: null, rawValue: null, valueType: ValueType.IntDec, data: 6 });
    const re = parseAxml(serializeAxml(doc));
    expect(re.root.attributes.map((a) => [a.name, a.data])).toEqual([['a', re.root.attributes[0]!.data], ['n1', re.root.attributes[1]!.data], ['n2', 5], ['n3', 6]]);
    expect(re.root.attributes[1]!.stringValue).toBe('str');
  });

  it('addAttr with a resource id inserts into the style table too', () => {
    const bytes = build(plain(), { styles: 2 });
    const doc = parseAxml(bytes);
    addAttr(doc, doc.root, { nsUri: ANDROID_NS, name: 'label', resourceId: RID.label, rawValue: null, valueType: ValueType.IntDec, data: 1 });
    const out = serializeAxml(doc);
    expect(Number(dump(out)[0]!.split(' ')[1])).toBe(Number(dump(bytes)[0]!.split(' ')[1]) + 1); // the new attribute name
    expect(hexOf(serializeAxml(parseAxml(out)))).toBe(hexOf(out));
    expect(getAttr(parseAxml(out).root, 'a', null)!.stringValue).toBe('old');
  });
});

describe('axml queries', () => {
  it('findElements passes paths; getAttr matches by id, name and namespace', () => {
    const doc = parse(manifest());
    const paths: string[] = [];
    const acts = findElements(doc, (e, p) => { paths.push(p.join('/')); return e.name === 'activity'; });
    expect(acts).toHaveLength(2);
    expect(paths[0]).toBe('manifest');
    expect(paths).toContain('manifest/application/activity');
    const a = acts[0]!;
    // wrong resource id falls back to name + namespace lookup
    expect(getAttr(a, 'theme', ANDROID_NS, 0x7f)?.data).toBe(0x01030005);
    expect(getAttr(a, 'theme', 'urn:other')).toBeUndefined();
    expect(getAttr(a, 'theme')).toBeDefined();
    expect(getAttr(a, 'missing')).toBeUndefined();
    expect(findElementsByName(doc, 'activity', 'nope')).toEqual([]);
  });
});

describe('manifestInfo', () => {
  it('reads package, version and sdk values', () => {
    expect(manifestInfo(parse(manifest()))).toEqual({
      package: 'com.noodlecake.blockheads', versionName: '1.7.4', versionCode: 1548230154, minSdk: 16, targetSdk: 30,
    });
  });
  it('accepts hex ints and tolerates missing optional parts', () => {
    const m: BEl = {
      name: 'manifest',
      attrs: [{ name: 'package', str: 'p' }, { name: 'versionCode', res: RID.versionCode, type: 0x11, data: 0xdeadbeef }],
      children: [{ name: 'uses-sdk', attrs: [{ name: 'targetSdkVersion', res: RID.targetSdk, type: 0x11, data: 0x21 }] }],
    };
    expect(manifestInfo(parse(m))).toEqual({ package: 'p', versionCode: 0xdeadbeef, targetSdk: 0x21 });
    const onlyMin: BEl = { name: 'manifest', attrs: [{ name: 'package', str: 'p' }], children: [{ name: 'uses-sdk', attrs: [{ name: 'minSdkVersion', res: RID.minSdk, type: 0x10, data: 9 }] }] };
    expect(manifestInfo(parse(onlyMin))).toEqual({ package: 'p', minSdk: 9 });
    expect(manifestInfo(parse({ name: 'manifest', attrs: [{ name: 'package', str: 'p' }] }))).toEqual({ package: 'p' });
  });
  it('ignores non-string versionName and non-integer versionCode', () => {
    const m: BEl = {
      name: 'manifest',
      attrs: [
        { name: 'package', str: 'p' },
        { name: 'versionName', res: RID.versionName, type: 0x10, data: 3 },
        { name: 'versionCode', res: RID.versionCode, type: 0x01, data: 3 },
      ],
    };
    expect(manifestInfo(parse(m))).toEqual({ package: 'p' });
  });
  it('rejects a wrong root and a missing / non-string package', () => {
    expect(() => manifestInfo(parse({ name: 'application' }))).toThrow(/not <manifest>/);
    expect(() => manifestInfo(parse({ name: 'manifest' }))).toThrow(/no package/);
    expect(() => manifestInfo(parse({ name: 'manifest', attrs: [{ name: 'package', type: 0x10, data: 1 }] }))).toThrow(/no package/);
  });
});

describe('axml mutation', () => {
  it('setAttrValue changes a reference in place without touching anything else', () => {
    const bytes = build(manifest());
    const doc = parseAxml(bytes);
    const theme = getAttr(findElementsByName(doc, 'activity', ACTIVITY)[0]!, 'theme', ANDROID_NS, RID.theme)!;
    setAttrValue(doc, theme, ValueType.Reference, 0x01030011);
    const out = serializeAxml(doc);
    expect(out.length).toBe(bytes.length);
    const diff = [...out].flatMap((v, i) => (v !== bytes[i] ? [i] : []));
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.length).toBeLessThanOrEqual(4);
    expect(getAttr(findElementsByName(parseAxml(out), 'activity', ACTIVITY)[0]!, 'theme', ANDROID_NS, RID.theme)!.data).toBe(0x01030011);
  });

  it('setAttrValue string -> non-string drops the raw value, and non-string -> string resolves the string', () => {
    const doc = parse(manifest());
    const name = getAttr(findElementsByName(doc, 'activity', ACTIVITY)[0]!, 'name', ANDROID_NS, RID.name)!;
    setAttrValue(doc, name, ValueType.IntDec, 5);
    expect(name).toMatchObject({ valueType: ValueType.IntDec, data: 5, rawValue: null });
    expect(name.stringValue).toBeUndefined();
    const re = parseAxml(serializeAxml(doc));
    expect(getAttr(re.root.children[1]!.children[0]!, 'name', ANDROID_NS, RID.name)).toMatchObject({ valueType: ValueType.IntDec, data: 5, rawValue: null });
    // back to a String pointing at an existing pool entry
    const pkg = getAttr(doc.root, 'package', null)!;
    const vn = getAttr(doc.root, 'versionName', ANDROID_NS)!;
    setAttrValue(doc, pkg, ValueType.String, vn.data);
    expect(pkg.stringValue).toBe('1.7.4');
  });

  it('setAttrValue to String with an unusable index yields an empty string value', () => {
    const doc = parse({ name: 'r', attrs: [{ name: 'a', type: 0x10, data: 1 }] });
    const a = doc.root.attributes[0]!;
    setAttrValue(doc, a, ValueType.String, NONE);
    expect(a.stringValue).toBe('');
  });

  it('setAttrString reuses an existing string and appends new ones (any encoding)', () => {
    for (const utf8 of [true, false]) {
      const doc = parse(manifest(), { utf8 });
      const vn = getAttr(doc.root, 'versionName', ANDROID_NS)!;
      const before = dump(serializeAxml(doc));
      setAttrString(doc, vn, 'com.noodlecake.blockheads'); // existing pool entry (after the resource names)
      expect(vn.stringValue).toBe('com.noodlecake.blockheads');
      setAttrString(doc, vn, '9.9.9');
      const out = serializeAxml(doc);
      expect(manifestInfo(parseAxml(out)).versionName).toBe('9.9.9');
      expect(dump(out).length).toBe(before.length);
      setAttrString(doc, vn, 'ü'.repeat(200));
      expect(manifestInfo(parseAxml(serializeAxml(doc))).versionName).toBe('ü'.repeat(200));
    }
    const big = parse(manifest(), { utf8: false });
    setAttrString(big, getAttr(big.root, 'package', null)!, 'k'.repeat(40000));
    expect(manifestInfo(parseAxml(serializeAxml(big))).package).toBe('k'.repeat(40000));
  });

  it('rejects foreign documents, elements and attributes', () => {
    const doc = parse(manifest());
    const foreign: AxmlDocument = { root: doc.root };
    const fakeAttr: AxmlAttribute = { nsUri: null, name: 'x', resourceId: null, rawValue: null, valueType: ValueType.IntDec, data: 1 };
    const fakeEl: AxmlElement = { name: 'x', nsUri: null, attributes: [], children: [], lineNumber: 1 };
    expect(() => serializeAxml(foreign)).toThrow(/not created by parseAxml/);
    expect(() => setAttrValue(foreign, doc.root.attributes[0]!, ValueType.IntDec, 1)).toThrow(AxmlError);
    expect(() => setAttrString(foreign, doc.root.attributes[0]!, 'x')).toThrow(AxmlError);
    expect(() => setAttrValue(doc, fakeAttr, ValueType.IntDec, 1)).toThrow(/unknown attribute/);
    expect(() => setAttrString(doc, fakeAttr, 'x')).toThrow(/unknown attribute/);
    expect(() => addAttr(doc, fakeEl, { nsUri: null, name: 'y', resourceId: null, rawValue: null, valueType: ValueType.IntDec, data: 1 })).toThrow(/unknown element/);
    doc.root.children.push(fakeEl);
    expect(() => serializeAxml(doc)).toThrow(/element was not created/);
    doc.root.children.pop();
    doc.root.attributes.push(fakeAttr);
    expect(() => serializeAxml(doc)).toThrow(/attribute was not created/);
  });
});

describe('addAttr', () => {
  const label = (extra: Partial<Parameters<typeof addAttr>[2]> = {}): Parameters<typeof addAttr>[2] =>
    ({ nsUri: ANDROID_NS, name: 'label', resourceId: RID.label, rawValue: 'Hello', valueType: ValueType.String, data: 0, ...extra });

  /** Everything except the pool/resmap headers and the edited element must be unchanged; the edited line differs only by the new attribute. */
  function expectOnlyAdded(before: string[], after: string[], added: string, elementPrefix: string) {
    expect(after).toHaveLength(before.length);
    let changed = 0;
    after.forEach((line, i) => {
      if (line.startsWith('pool ') || line.startsWith('resmap ') || line === before[i]) return;
      changed++;
      expect(line.startsWith(elementPrefix)).toBe(true);
      expect(line).toContain(added);
      expect(line.replace(' ' + added, '')).toBe(before[i]);
    });
    expect(changed).toBe(1);
  }

  for (const utf8 of [true, false]) {
    for (const styles of [0, 2]) {
      it(`inserts a resource-id string attribute keeping all references valid (utf8=${utf8}, styles=${styles})`, () => {
        const root = manifest();
        root.texts = [{ pos: 0, value: 'text-a' }, { pos: 1, value: 'text-b', typedString: true }];
        root.children![1]!.texts = [{ pos: 2, value: 'tail', typedString: true }];
        const opts: BuildOptions = { utf8, styles, before: ['pre'], after: ['post'] };
        const bytes = build(root, opts);
        const doc = parseAxml(bytes);
        const before = dump(bytes);
        const act = findElementsByName(doc, 'activity', ACTIVITY)[0]!;
        const at = addAttr(doc, act, label());
        expect(at.stringValue).toBe('Hello');
        const out = serializeAxml(doc);
        expectOnlyAdded(before, dump(out), `${ANDROID_NS}:label[1010001]raw=Hello/3:Hello`, 'el -:activity');
        // reparse + serialize is stable and the structure is intact
        const re = parseAxml(out);
        expect(hexOf(serializeAxml(re))).toBe(hexOf(out));
        expect(getAttr(findElementsByName(re, 'activity', ACTIVITY)[0]!, 'label', ANDROID_NS, RID.label)!.stringValue).toBe('Hello');
        expect(manifestInfo(re)).toMatchObject({ package: 'com.noodlecake.blockheads', versionName: '1.7.4', minSdk: 16 });
      });
    }
  }

  it('keeps attributes ordered by resource id and bumps id/class/style indexes past the insertion point', () => {
    const attrs = (): BEl['attrs'] => [
      { name: 'theme', res: RID.theme, type: 1, data: 2 },
      { name: 'name', res: RID.name, str: 'n' },
      { name: 'plain', str: 'p' },
    ];
    const extra = { nsUri: ANDROID_NS, name: 'label', resourceId: RID.label, rawValue: null, valueType: ValueType.IntDec, data: 4 };
    // inserted at position 1; an id index of 1 is not after it and stays, 3 moves
    for (const [idIndex, expected] of [[0, 0], [1, 1], [3, 4]] as const) {
      const doc = parse({ name: 'r', attrs: attrs(), idIndex });
      addAttr(doc, doc.root, extra);
      // theme (0x01010000) < label (0x01010001) < name (0x01010003); id-less attributes last
      expect(doc.root.attributes.map((a) => a.name)).toEqual(['theme', 'label', 'name', 'plain']);
      expect(dump(serializeAxml(doc)).find((l) => l.startsWith('el -:r'))).toContain(` id=${expected} `);
    }
  });

  it('creates the resource map when the document has none', () => {
    const bytes = build({ name: 'r', children: [{ name: 'c', attrs: [{ name: 'plain', str: 'v' }] }] });
    const doc = parseAxml(bytes);
    const before = dump(bytes);
    expect(before.some((l) => l.startsWith('resmap'))).toBe(false);
    addAttr(doc, doc.root.children[0]!, label());
    const after = dump(serializeAxml(doc));
    expect(after.some((l) => l.startsWith('resmap 1'))).toBe(true);
    const re = parseAxml(serializeAxml(doc));
    expect(getAttr(re.root.children[0]!, 'label', ANDROID_NS, RID.label)!.stringValue).toBe('Hello');
    expect(getAttr(re.root.children[0]!, 'plain', null)!.stringValue).toBe('v');
  });

  it('reuses an existing resource-mapped name, and appends names for new ids', () => {
    const doc = parse(manifest());
    const before = dump(serializeAxml(doc));
    const act = findElementsByName(doc, 'activity', '.Other')[0]!;
    addAttr(doc, act, { nsUri: ANDROID_NS, name: 'theme', resourceId: RID.theme, rawValue: null, valueType: ValueType.Reference, data: 7 });
    const after = dump(serializeAxml(doc));
    expect(after.find((l) => l.startsWith('pool'))).toBe(before.find((l) => l.startsWith('pool')));
    expect(after.find((l) => l.startsWith('resmap'))).toBe(before.find((l) => l.startsWith('resmap')));
    // same name, different id => a new mapped name is inserted
    addAttr(doc, act, { nsUri: ANDROID_NS, name: 'theme', resourceId: 0x01010999, rawValue: null, valueType: ValueType.IntDec, data: 1 });
    expect(dump(serializeAxml(doc)).find((l) => l.startsWith('resmap'))).toBe(`resmap ${Number(before.find((l) => l.startsWith('resmap'))!.split(' ')[1]) + 1}`);
  });

  it('adds attributes without a resource id or namespace, with and without a raw value', () => {
    const doc = parse(manifest());
    const act = findElementsByName(doc, 'activity', ACTIVITY)[0]!;
    const s = addAttr(doc, act, { nsUri: null, name: 'tag', resourceId: null, rawValue: 'v1', valueType: ValueType.String, data: 0 });
    const n = addAttr(doc, act, { nsUri: null, name: 'count', resourceId: null, rawValue: '12', valueType: ValueType.IntDec, data: 12 });
    const m = addAttr(doc, act, { nsUri: null, name: 'bare', resourceId: null, rawValue: null, valueType: ValueType.IntDec, data: 1 });
    expect(act.attributes.slice(-3).map((a) => a.name)).toEqual(['tag', 'count', 'bare']);
    expect([s.stringValue, n.rawValue, m.rawValue]).toEqual(['v1', '12', null]);
    const re = parseAxml(serializeAxml(doc));
    const ra = findElementsByName(re, 'activity', ACTIVITY)[0]!;
    expect(getAttr(ra, 'tag', null)!.stringValue).toBe('v1');
    expect(getAttr(ra, 'count', null)).toMatchObject({ rawValue: '12', data: 12 });
    expect(getAttr(ra, 'bare', null)!.rawValue).toBeNull();
  });

  it('requires a raw value for String attributes', () => {
    const doc = parse(manifest());
    expect(() => addAttr(doc, doc.root, label({ rawValue: null }))).toThrow(/rawValue required/);
  });
});

describe('axml parse errors', () => {
  const pool = poolChunk(['a', 'b'], true);
  const hdr = (extra: number[] = []) => [...u32(1), ...u32(NONE), ...extra];
  const startEl = (name = 0, o: { attrSize?: number; count?: number; attrs?: number[]; hsize?: number } = {}) =>
    chunk(T.START_EL, o.hsize ?? 16, hdr([...u32(NONE), ...u32(name), ...u16(20), ...u16(o.attrSize ?? 20), ...u16(o.count ?? 0), ...u16(0), ...u16(0), ...u16(0), ...(o.attrs ?? [])]));
  const endEl = (name = 0) => chunk(T.END_EL, 16, hdr([...u32(NONE), ...u32(name)]));
  const startNs = () => chunk(T.START_NS, 16, hdr([...u32(0), ...u32(1)]));
  const endNs = () => chunk(T.END_NS, 16, hdr([...u32(0), ...u32(1)]));
  const bad = (chunks: number[][], re: RegExp) => expect(() => parseAxml(xmlFile(chunks))).toThrow(re);

  it('rejects malformed headers and chunk sizes', () => {
    expect(() => parseAxml(new Uint8Array(4))).toThrow(/too small/);
    expect(() => parseAxml(Uint8Array.from([...u16(0x1234), ...u16(8), ...u32(8)]))).toThrow(/bad magic/);
    expect(() => parseAxml(Uint8Array.from([...u16(T.XML), ...u16(8), ...u32(99)]))).toThrow(/bad file size/);
    expect(() => parseAxml(Uint8Array.from([...u16(T.XML), ...u16(8), ...u32(4)]))).toThrow(/bad file size/);
    expect(() => parseAxml(Uint8Array.from([...u16(T.XML), ...u16(8), ...u32(12), 1, 2, 3, 4]))).toThrow(/truncated chunk header/);
    const tiny = pool.slice();
    tiny.splice(4, 4, ...u32(4));
    expect(() => parseAxml(xmlFile([tiny]))).toThrow(/bad chunk size/);
    const huge = pool.slice();
    huge.splice(4, 4, ...u32(10000));
    expect(() => parseAxml(xmlFile([huge]))).toThrow(/bad chunk size/);
  });

  it('rejects structural problems', () => {
    bad([pool, pool], /duplicate string pool/);
    bad([startNs()], /before string pool/);
    bad([pool, startEl(0, { hsize: 20 })], /node header size/);
    bad([pool, startEl(0), startNs()], /inside element/);
    bad([pool, endNs()], /unbalanced end namespace/);
    bad([pool, startEl(0, { attrSize: 24 })], /attribute size/);
    bad([pool, startEl(0, { count: 3 }), endEl()], /attribute out of chunk/);
    bad([pool, startEl(0), endEl(), startEl(1), endEl(1)], /multiple root/);
    bad([pool, endEl()], /unbalanced end element/);
    bad([pool, chunk(0x0105, 16, hdr([...u32(0), ...u32(0)]))], /unknown chunk type 0x105/);
    bad([chunk(T.RESMAP, 8, u32(0x01010000))], /missing string pool/);
    bad([pool], /missing or unbalanced root/);
    bad([pool, startEl(0)], /missing or unbalanced root/);
    bad([pool, startNs(), startEl(0), endEl(), ], /missing or unbalanced root/);
  });

  it('rejects out-of-range string references', () => {
    bad([pool, startEl(99), endEl(99)], /string index 99 out of range/);
  });
});
