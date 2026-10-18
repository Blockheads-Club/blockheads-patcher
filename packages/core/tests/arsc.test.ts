import { describe, it, expect } from 'vitest';
import {
  ArscError, StringPool, parseArsc, serializeArsc, findPackage, findTypeId, typeNameOf, findResource, getResource, decodeEntry, addResource, addConfig,
  resourceId, makeConfig, parseConfig, configEquals, configChangeFlags, configToString, CONFIG_CHANGE, DENSITY, ResValue,
} from '../src';
import { buildArsc, cfg, type BTable, type BType } from './arsc-builder';
import { chunk, poolChunk, u32 } from './axml-builder';

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const color = (key: string, data = 0xff0000ff) => ({ key, value: { type: ResValue.ColorArgb8, data } });
const file = (key: string, path: string) => ({ key, value: { str: path } });

function drawableType(): BType {
  return {
    name: 'drawable', specFlags: [CONFIG_CHANGE.density, 0],
    configs: [
      { config: cfg(), entries: [file('icon', 'res/drawable/icon.png'), color('bg')] },
      { config: cfg({ density: DENSITY.hdpi, sdk: 4 }), entries: [file('icon', 'res/drawable-hdpi/icon.png'), null] },
    ],
  };
}
const styleType = (layout: 'dense' | 'sparse' | 'offset16' = 'sparse'): BType => ({
  name: 'style',
  configs: [{
    config: cfg(), layout,
    entries: [null, { key: 'Theme', value: { complex: [{ name: 0x01010000, type: 0x01, data: 0x7f000001 }, { name: 0x01010001, type: 0x12, data: 1 }], parent: 0x01030005 } }, null],
  }],
});
const base = (over: Partial<BTable> = {}): BTable => ({ packages: [{ types: [drawableType(), styleType()] }], ...over });

describe('config helpers', () => {
  it('builds, parses and prints configs', () => {
    const c = makeConfig({ density: DENSITY.anydpi, sdkVersion: 26, orientation: 2, mcc: 262, mnc: 3 });
    expect(c.length).toBe(28);
    expect(parseConfig(c)).toMatchObject({ density: 0xfffe, sdkVersion: 26, orientation: 2, mcc: 262, mnc: 3 });
    expect(configToString(c)).toBe('mcc262-mnc3-land-anydpi-v26');
    expect(configToString(makeConfig())).toBe('');
    expect(configToString(makeConfig({ orientation: 1, density: 200 }))).toBe('port-200dpi');
    expect(configToString(makeConfig({ orientation: 3 }))).toBe('square');
    expect(configToString(new Uint8Array(cfg({ lang: 'en' })))).toBe('en');
    expect(configToString(new Uint8Array(cfg({ lang: 'en', country: 'US' })))).toBe('en-rUS');
    expect(configToString(new Uint8Array(cfg({ country: 'D' })))).toBe('');
  });
  it('reads fields of larger configs and tolerates short ones', () => {
    const big = new Uint8Array(cfg({ size: 64, density: 320 }));
    big[28] = 0x12; big[29] = 0x03; big.set([0x10, 0x00], 30); big.set([0x20, 0x00], 32); big.set([0x30, 0x00], 34);
    expect(parseConfig(big)).toMatchObject({ density: 320, screenLayout: 0x12, uiMode: 3, smallestScreenWidthDp: 16, screenWidthDp: 32, screenHeightDp: 48 });
    expect(parseConfig(new Uint8Array([4, 0, 0, 0])).density).toBe(0);
    expect(parseConfig(new Uint8Array([4, 0, 0, 0, 7])).mcc).toBe(0);
  });
  it('compares configs by qualifiers and derives change flags', () => {
    expect(configEquals(makeConfig({ density: 160 }), new Uint8Array(cfg({ density: 160, size: 40 })))).toBe(true);
    expect(configEquals(new Uint8Array(cfg({ density: 160, size: 40 })), makeConfig({ density: 160 }))).toBe(true);
    expect(configEquals(makeConfig({ density: 160 }), makeConfig({ density: 240 }))).toBe(false);
    expect(configEquals(makeConfig(), new Uint8Array(cfg({ size: 32 })).fill(1, 28))).toBe(false);
    const all = makeConfig({ mcc: 1, mnc: 1, orientation: 1, density: 160, sdkVersion: 4 });
    all.set([0x65, 0x6e], 8);
    expect(configChangeFlags(all)).toBe(0x1 | 0x2 | 0x4 | 0x80 | 0x100 | 0x400);
    expect(configChangeFlags(makeConfig())).toBe(0);
    const country = makeConfig();
    country[10] = 0x55;
    expect(configChangeFlags(country)).toBe(CONFIG_CHANGE.locale);
  });
});

describe('StringPool', () => {
  const poolBytes = (strings: string[], utf8: boolean, styles = 0) => Uint8Array.from(poolChunk(strings, utf8, styles));
  it('round-trips UTF-8 and UTF-16 pools including styles', () => {
    for (const utf8 of [true, false]) for (const styles of [0, 2]) {
      const b = poolBytes(['a', 'b', 'héllo €'], utf8, styles);
      const { pool, size } = StringPool.parse(b, 0);
      expect(size).toBe(b.length);
      expect(pool.all()).toEqual(['a', 'b', 'héllo €']);
      expect(pool.isUtf8).toBe(utf8);
      expect(pool.styleCount).toBe(styles);
      expect(same(pool.serialize(), b)).toBe(true);
    }
  });
  it('appends strings, dedupes and clears the sorted flag', () => {
    const b = poolBytes(['x'], true);
    new DataView(b.buffer).setUint32(16, 0x101, true);
    const { pool } = StringPool.parse(b, 0);
    expect(pool.add('x')).toBe(0);
    expect(pool.add('y')).toBe(1);
    expect(pool.indexOf('y')).toBe(1);
    expect(pool.indexOf('nope')).toBe(-1);
    expect(pool.length).toBe(2);
    const again = StringPool.parse(pool.serialize(), 0).pool;
    expect(again.all()).toEqual(['x', 'y']);
    expect(new DataView(pool.serialize().buffer).getUint32(16, true)).toBe(0x100);
  });
  it('encodes long strings in both encodings', () => {
    const long = 'é'.repeat(300);
    for (const utf8 of [true, false]) {
      const huge = 'z'.repeat(utf8 ? 20000 : 40000);
      const pool = StringPool.create(utf8);
      pool.add(long);
      pool.add(huge);
      pool.add('');
      const back = StringPool.parse(pool.serialize(), 0).pool;
      expect(back.all()).toEqual([long, huge, '']);
    }
    expect(() => StringPool.create(true).add('z'.repeat(40000))).toThrow(/too long/);
    expect(() => StringPool.create(true).add('€'.repeat(12000))).toThrow(/too long/);
  });
  it('create() makes an empty pool that serializes without strings', () => {
    const p = StringPool.create();
    expect(p.length).toBe(0);
    expect(StringPool.parse(p.serialize(), 0).pool.length).toBe(0);
  });
  it('get() rejects out of range indices', () => {
    expect(() => StringPool.create().get(0)).toThrow(ArscError);
  });
  it('rejects malformed pools', () => {
    const good = poolBytes(['a', 'b'], true, 1);
    const mut = (f: (dv: DataView, b: Uint8Array) => void): Uint8Array => { const c = good.slice(); f(new DataView(c.buffer), c); return c; };
    expect(() => StringPool.parse(new Uint8Array(10), 0)).toThrow(/no string pool/);
    expect(() => StringPool.parse(mut((dv) => dv.setUint16(0, 2, true)), 0)).toThrow(/no string pool/);
    expect(() => StringPool.parse(mut((dv) => dv.setUint32(4, 99999, true)), 0)).toThrow(/bad string pool header/);
    expect(() => StringPool.parse(mut((dv) => dv.setUint16(2, 20, true)), 0)).toThrow(/bad string pool header/);
    expect(() => StringPool.parse(mut((dv) => dv.setUint32(8, 9999, true)), 0)).toThrow(/offset table/);
    expect(() => StringPool.parse(mut((dv) => dv.setUint32(28, 99999, true)), 0)).toThrow(/out of range/);
    // style span list never terminated: wipe the 0xFFFFFFFF markers
    expect(() => StringPool.parse(mut((_, b) => b.fill(0, 28 + 12 + 8)), 0)).toThrow(/not terminated|out of range/);
  });
});

describe('parse / serialize', () => {
  const variants: [string, BTable][] = [
    ['dense', base()],
    ['offset16 and utf-16 pools', base({ utf8: false, packages: [{ utf8: false, types: [drawableType(), styleType('offset16')] }] })],
    ['sparse + style strings', base({ strings: ['s1', 's2'], styles: 2 })],
    ['284-byte package header', base({ packages: [{ headerSize: 284, types: [drawableType()] }] })],
    ['two packages and an unknown package child', base({
      packages: [
        { types: [drawableType()], extra: [chunk(0x0203, 12, [...u32(0)])] },
        { id: 0x01, name: 'android', types: [styleType('dense')] },
      ],
    })],
    ['type id offset', base({ packages: [{ typeIdOffset: 2, types: [drawableType()] }] })],
  ];
  it.each(variants)('round-trips %s byte-identically', (_, t) => {
    const b = buildArsc(t);
    expect(same(serializeArsc(parseArsc(b)), b)).toBe(true);
  });
  it('reads the model', () => {
    const t = parseArsc(buildArsc(base({ packages: [{ id: 0x7f, name: 'com.example', types: [drawableType(), styleType()] }] })));
    const pkg = t.packages[0]!;
    expect(pkg.name).toBe('com.example');
    expect(pkg.id).toBe(0x7f);
    expect(pkg.typePool.all()).toEqual(['drawable', 'style']);
    expect(pkg.chunks.map((c) => c.kind)).toEqual(['spec', 'type', 'type', 'spec', 'type']);
    expect(t.pool.all()).toContain('res/drawable/icon.png');
  });
  it('names a package field that fills all 128 units', () => {
    const b = buildArsc(base({ packages: [{ name: 'p'.repeat(128), types: [drawableType()] }] }));
    expect(parseArsc(b).packages[0]!.name).toBe('p'.repeat(128));
  });
  it('sparse chunks keep their entry positions', () => {
    const t = parseArsc(buildArsc(base()));
    expect(findResource(t, 'style', 'Theme')).toBe(0x7f020001);
    const chunkS = t.packages[0]!.chunks.find((c) => c.kind === 'type' && c.type.id === 2);
    expect(chunkS && chunkS.kind === 'type' && chunkS.type.entries.map((e) => e !== undefined)).toEqual([false, true, false]);
  });
  it('rejects malformed tables', () => {
    const good = buildArsc(base());
    const mut = (f: (dv: DataView, b: Uint8Array) => void, src = good): Uint8Array => { const c = src.slice(); f(new DataView(c.buffer), c); return c; };
    expect(() => parseArsc(new Uint8Array(4))).toThrow(/not a resource table/);
    expect(() => parseArsc(mut((dv) => dv.setUint16(0, 3, true)))).toThrow(/not a resource table/);
    expect(() => parseArsc(mut((dv) => dv.setUint32(4, 1 << 30, true)))).toThrow(/bad resource table header/);
    expect(() => parseArsc(mut((dv) => dv.setUint16(2, 4, true)))).toThrow(/bad resource table header/);
    expect(() => parseArsc(mut((dv) => dv.setUint32(8, 2, true)))).toThrow(/package count/);
    const poolLen = new DataView(good.buffer).getUint32(12 + 4, true);
    expect(() => parseArsc(mut((dv) => dv.setUint16(12 + poolLen, 0x0201, true)))).toThrow(/unexpected chunk/);
    expect(() => parseArsc(mut((dv) => dv.setUint32(12 + poolLen + 4, 4, true)))).toThrow(/unexpected chunk/);
    expect(() => parseArsc(mut((dv) => dv.setUint32(4, 12 + poolLen + 4, true)))).toThrow(/truncated table chunk/);
  });
  it('rejects malformed packages and chunks', () => {
    const good = buildArsc(base());
    const pkgAt = 12 + new DataView(good.buffer).getUint32(16, true);
    const mut = (f: (dv: DataView, b: Uint8Array) => void): Uint8Array => { const c = good.slice(); f(new DataView(c.buffer), c); return c; };
    expect(() => parseArsc(mut((dv) => dv.setUint16(pkgAt + 2, 100, true)))).toThrow(/bad package header/);
    const dvg = new DataView(good.buffer);
    const children = pkgAt + 288 + dvg.getUint32(pkgAt + 288 + 4, true) + dvg.getUint32(pkgAt + 288 + dvg.getUint32(pkgAt + 288 + 4, true) + 4, true);
    expect(() => parseArsc(mut((dv) => dv.setUint32(children + 4, 4, true)))).toThrow(/bad chunk size in package/);
    // a type chunk whose entry data is cut off
    expect(() => parseArsc(mut((dv) => dv.setUint32(children + 16 + dvg.getUint32(children + 4, true) - 16 + 4, 0xfffff, true)))).toThrow(ArscError);
  });
  it('rejects broken type chunks, entries and typeSpecs', () => {
    const find = (b: Uint8Array, type: number, nth = 0): number => {
      const dv = new DataView(b.buffer);
      let p = 12 + dv.getUint32(16, true) + 288;
      p += dv.getUint32(p + 4, true);
      p += dv.getUint32(p + 4, true);
      for (let n = 0; ; p += dv.getUint32(p + 4, true)) if (dv.getUint16(p, true) === type && n++ === nth) return p;
    };
    const cases: [string, (dv: DataView, at: number) => void, number, BTable?][] = [
      ['short header', (dv, at) => dv.setUint16(at + 2, 10, true), 0x0201],
      ['entry count beyond chunk', (dv, at) => dv.setUint32(at + 12, 0xfffff, true), 0x0201],
      ['entriesStart beyond chunk', (dv, at) => dv.setUint32(at + 16, 0xfffff, true), 0x0201],
      ['typeSpec count beyond chunk', (dv, at) => dv.setUint32(at + 12, 0xfffff, true), 0x0202],
      ['entry offset beyond chunk', (dv, at) => dv.setUint32(at + dv.getUint16(at + 2, true), 0x7ffff, true), 0x0201],
      ['complex entry larger than the chunk', (dv, at) => dv.setUint32(at + dv.getUint32(at + 16, true) + 12, 0xffff, true), 0x0201, base({ packages: [{ types: [styleType('dense')] }] })],
    ];
    for (const [name, f, type, src] of cases) {
      const c = (src ? buildArsc(src) : buildArsc(base())).slice();
      f(new DataView(c.buffer), find(c, type));
      expect(() => parseArsc(c), name).toThrow(ArscError);
    }
  });
  it('rejects a package with a dangling partial chunk header', () => {
    expect(() => parseArsc(buildArsc(base({ packages: [{ types: [drawableType()], extra: [[1, 2, 3, 4]] }] })))).toThrow(/truncated package chunk/);
  });
  it('tolerates type chunks without a preceding typeSpec', () => {
    const b = buildArsc(base({ packages: [{ types: [drawableType()] }] }));
    const dv = new DataView(b.buffer);
    let p = 12 + dv.getUint32(16, true) + 288;
    p += dv.getUint32(p + 4, true);
    p += dv.getUint32(p + 4, true);
    dv.setUint16(p, 0x0299, true);
    const t = parseArsc(b);
    expect(t.packages[0]!.chunks.map((c) => c.kind)).toEqual(['other', 'type', 'type']);
    expect(same(serializeArsc(t), b)).toBe(true);
  });
  it('rejects compact entries and bad complex entries', () => {
    const b = buildArsc(base());
    const dv0 = new DataView(b.buffer);
    let p = 12 + dv0.getUint32(16, true) + 288;
    p += dv0.getUint32(p + 4, true);
    p += dv0.getUint32(p + 4, true);
    p += dv0.getUint32(p + 4, true); // past the first spec
    const entryAt = p + dv0.getUint16(p + 2, true) + 2 * 4; // entries start after offsets (2 entries)
    const compact = b.slice();
    new DataView(compact.buffer).setUint16(entryAt + 2, 0x8, true);
    expect(() => parseArsc(compact)).toThrow(/compact/);
    const badComplex = b.slice();
    new DataView(badComplex.buffer).setUint16(entryAt + 2, 0x1, true);
    expect(() => parseArsc(badComplex)).toThrow(/bad complex entry/);
  });
  it('rejects sparse entries pointing outside the type', () => {
    const b = buildArsc(base());
    const dv = new DataView(b.buffer);
    let p = 12 + dv.getUint32(16, true) + 288;
    p += dv.getUint32(p + 4, true);
    p += dv.getUint32(p + 4, true);
    for (let n = 0; n < 3; n++) p += dv.getUint32(p + 4, true); // spec, type, type -> spec of style
    p += dv.getUint32(p + 4, true); // style spec
    expect(dv.getUint8(p + 9)).toBe(1); // sparse
    dv.setUint16(p + dv.getUint16(p + 2, true), 99, true);
    expect(() => parseArsc(b)).toThrow(/sparse entry index/);
  });
});

describe('lookup', () => {
  const t = () => parseArsc(buildArsc(base({ packages: [{ types: [drawableType(), styleType()] }, { id: 0x01, name: 'android', types: [] }] })));
  it('finds packages, types and resources', () => {
    const table = t();
    expect(findPackage(table).id).toBe(0x7f);
    expect(findPackage(table, 0x01).name).toBe('android');
    expect(() => findPackage(table, 0x55)).toThrow(/no package 0x55/);
    expect(() => findPackage({ pool: table.pool, packages: [] })).toThrow(/no package/);
    const pkg = findPackage(table);
    expect(findTypeId(pkg, 'style')).toBe(2);
    expect(findTypeId(pkg, 'nope')).toBeUndefined();
    expect(typeNameOf(pkg, 2)).toBe('style');
    expect(findResource(table, 'drawable', 'bg')).toBe(0x7f010001);
    expect(findResource(table, 'drawable', 'bg', 0x7f)).toBe(0x7f010001);
    expect(findResource(table, 'nope', 'bg')).toBeUndefined();
    expect(findResource(table, 'drawable', 'nope')).toBeUndefined();
    expect(findResource(table, 'style', 'bg')).toBeUndefined();
    expect(resourceId(0x7f, 1, 2)).toBe(0x7f010002);
  });
  it('decodes resources with all their configs', () => {
    const table = t();
    const icon = getResource(table, findResource(table, 'drawable', 'icon')!)!;
    expect(icon.type).toBe('drawable');
    expect(icon.name).toBe('icon');
    expect(icon.configs.map((c) => configToString(c.config))).toEqual(['', 'hdpi-v4']);
    expect(icon.configs[1]!.entry).toMatchObject({ kind: 'value', dataType: 3, string: 'res/drawable-hdpi/icon.png' });
    const bg = getResource(table, 0x7f010001)!;
    expect(bg.configs).toHaveLength(1);
    expect(bg.configs[0]!.entry).toEqual({ kind: 'value', key: 'bg', flags: 0, dataType: 0x1c, data: 0xff0000ff });
    const theme = getResource(table, 0x7f020001)!;
    expect(theme.configs[0]!.entry).toEqual({
      kind: 'complex', key: 'Theme', flags: 1, parent: 0x01030005,
      items: [{ name: 0x01010000, dataType: 1, data: 0x7f000001 }, { name: 0x01010001, dataType: 0x12, data: 1 }],
    });
    expect(getResource(table, 0x7e010000)).toBeUndefined();
    expect(getResource(table, 0x7f010009)).toBeUndefined();
    const pkg = findPackage(table);
    const raw = (icon.configs[0]!.entry, new Uint8Array(0));
    expect(raw.length).toBe(0);
    expect(decodeEntry(table, pkg, Uint8Array.from([8, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0x10, 5, 0, 0, 0]))).toMatchObject({ key: 'icon', dataType: 0x10, data: 5 });
  });
});

describe('modification', () => {
  const fresh = () => parseArsc(buildArsc(base()));
  const anydpi26 = makeConfig({ density: DENSITY.anydpi, sdkVersion: 26 });

  it('adds a resource of a new type and keeps all existing ids', () => {
    const t = fresh();
    const before = ['icon', 'bg'].map((n) => findResource(t, 'drawable', n));
    const id = addResource(t, {
      type: 'mipmap', name: 'ic_launcher',
      configs: [
        { config: makeConfig({ density: DENSITY.nodpi }), value: { kind: 'string', value: 'res/mipmap-nodpi/ic.png' } },
        { config: anydpi26, value: { kind: 'string', value: 'res/mipmap-anydpi-v26/ic.xml' } },
      ],
    });
    expect(id).toBe(0x7f030000);
    const back = parseArsc(serializeArsc(t));
    expect(['icon', 'bg'].map((n) => findResource(back, 'drawable', n))).toEqual(before);
    expect(findResource(back, 'mipmap', 'ic_launcher')).toBe(id);
    const r = getResource(back, id)!;
    expect(r.configs.map((c) => configToString(c.config))).toEqual(['nodpi', 'anydpi-v26']);
    expect(r.configs[1]!.entry).toMatchObject({ string: 'res/mipmap-anydpi-v26/ic.xml' });
    const spec = findPackage(back).chunks.find((c) => c.kind === 'spec' && c.spec.id === 3);
    expect(spec && spec.kind === 'spec' && spec.spec.flags).toEqual([CONFIG_CHANGE.density | CONFIG_CHANGE.version]);
  });

  it('appends to an existing type: other configs and sparse chunks are padded, old entries untouched', () => {
    const t = fresh();
    const id = addResource(t, { type: 'drawable', name: 'extra', configs: [{ config: makeConfig(), value: { kind: 'value', dataType: ResValue.IntDec, data: 7 } }] });
    expect(id).toBe(0x7f010002);
    const sid = addResource(t, {
      type: 'style', name: 'Bag', configs: [{ config: makeConfig(), value: { kind: 'complex', parent: 0, items: [{ name: 0x0101, dataType: 0x10, data: 3 }] } }],
    });
    expect(sid).toBe(0x7f020003);
    const back = parseArsc(serializeArsc(t));
    expect(getResource(back, id)!.configs[0]!.entry).toMatchObject({ key: 'extra', data: 7 });
    expect(getResource(back, sid)!.configs[0]!.entry).toMatchObject({ kind: 'complex', parent: 0 });
    expect(getResource(back, 0x7f020001)!.configs[0]!.entry).toMatchObject({ kind: 'complex', parent: 0x01030005 });
    expect(getResource(back, 0x7f010000)!.configs).toHaveLength(2);
    // the hdpi chunk now has a third (empty) slot
    expect(getResource(back, 0x7f010001)!.configs).toHaveLength(1);
  });

  it('adds a configuration to an existing resource (new and existing config chunks) and updates the typeSpec', () => {
    const t = fresh();
    const icon = findResource(t, 'drawable', 'icon')!;
    addConfig(t, icon, anydpi26, { kind: 'string', value: 'res/drawable-anydpi-v26/icon.xml' });
    addConfig(t, 0x7f010001, makeConfig({ density: DENSITY.hdpi, sdkVersion: 4 }), { kind: 'value', dataType: ResValue.ColorArgb8, data: 1, flags: 2 });
    const back = parseArsc(serializeArsc(t));
    expect(getResource(back, icon)!.configs.map((c) => configToString(c.config))).toEqual(['', 'hdpi-v4', 'anydpi-v26']);
    expect(getResource(back, 0x7f010001)!.configs.map((c) => configToString(c.config))).toEqual(['', 'hdpi-v4']);
    const spec = findPackage(back).chunks.find((c) => c.kind === 'spec' && c.spec.id === 1);
    expect(spec && spec.kind === 'spec' && spec.spec.flags).toEqual([CONFIG_CHANGE.density | CONFIG_CHANGE.version, CONFIG_CHANGE.density | CONFIG_CHANGE.version]);
    // new type chunk is placed right after the chunks of its type, before the next typeSpec
    const kinds = findPackage(back).chunks.map((c) => (c.kind === 'type' ? `t${c.type.id}` : c.kind === 'spec' ? `s${c.spec.id}` : 'o'));
    expect(kinds).toEqual(['s1', 't1', 't1', 't1', 's2', 't2']);
  });

  it('shares string and key pool entries with the existing table', () => {
    const t = fresh();
    const keys = findPackage(t).keyPool.length;
    const strings = t.pool.length;
    addResource(t, { type: 'drawable', name: 'icon2', configs: [{ config: makeConfig(), value: { kind: 'string', value: 'res/drawable/icon.png' } }] });
    expect(findPackage(t).keyPool.length).toBe(keys + 1);
    expect(t.pool.length).toBe(strings);
  });

  it('serializes entries added to a sparse-typed table densely and keeps untouched chunks verbatim', () => {
    const b = buildArsc(base());
    const t = parseArsc(b);
    addResource(t, { type: 'drawable', name: 'n', configs: [{ config: makeConfig(), value: { kind: 'value', dataType: 0x10, data: 1 } }] });
    const out = serializeArsc(t);
    const styleChunk = Buffer.from(b).indexOf(Buffer.from(findPackage(parseArsc(b)).chunks.flatMap((c) => (c.kind === 'type' && c.type.id === 2 ? [c.type.source!] : []))[0]!));
    expect(styleChunk).toBeGreaterThan(0);
    expect(Buffer.from(out).includes(Buffer.from(b.subarray(styleChunk, styleChunk + 40)))).toBe(true);
  });

  it('rejects invalid additions', () => {
    const t = fresh();
    const ok = { config: makeConfig(), value: { kind: 'value', dataType: 0x10, data: 1 } } as const;
    expect(() => addResource(t, { type: 'x', name: 'y', configs: [] })).toThrow(/at least one configuration/);
    expect(() => addResource(t, { type: 'x', name: 'y', configs: [{ ...ok, config: new Uint8Array(10) }] })).toThrow(/28 bytes/);
    expect(() => addResource(t, { type: 'x', name: 'y', configs: [{ ...ok, config: new Uint8Array(30) }] })).toThrow(/multiple of 4/);
    expect(() => addResource(t, { type: 'drawable', name: 'icon', configs: [ok] })).toThrow(/already exists/);
    expect(() => addResource(t, { type: 'x', name: 'y', configs: [ok, ok] })).toThrow(/already has an entry/);
    expect(() => addResource(t, { type: 'x', name: 'y', packageId: 0x42, configs: [ok] })).toThrow(/no package/);
    expect(() => addConfig(t, 0x7f0a0000, makeConfig(), ok.value)).toThrow(/no resource/);
    expect(() => addConfig(t, findResource(t, 'drawable', 'icon')!, makeConfig(), ok.value)).toThrow(/already has an entry/);
  });

  it('refuses to overflow type or entry ids', () => {
    const tooManyTypes = parseArsc(buildArsc({ packages: [{ typeIdOffset: 254, types: [drawableType()] }] }));
    expect(() => addResource(tooManyTypes, { type: 'new', name: 'a', configs: [{ config: makeConfig(), value: { kind: 'value', dataType: 0x10, data: 1 } }] })).toThrow(/too many resource types/);
    const flags = new Array<number>(0x10000).fill(0);
    const full = parseArsc(buildArsc({ packages: [{ types: [{ name: 'id', specFlags: flags, configs: [{ config: cfg(), entries: [color('first')] }] }] }] }));
    expect(() => addResource(full, { type: 'id', name: 'more', configs: [{ config: makeConfig(), value: { kind: 'value', dataType: 0x10, data: 1 } }] })).toThrow(/too many entries/);
  });

  it('reuses a type name that exists in the pool without chunks', () => {
    const t = parseArsc(buildArsc({ packages: [{ types: [{ name: 'empty', configs: [] }] }] }));
    expect(findPackage(t).chunks.map((c) => c.kind)).toEqual(['spec']);
    const id = addResource(t, { type: 'empty', name: 'a', configs: [{ config: makeConfig(), value: { kind: 'value', dataType: 0x10, data: 1 } }] });
    expect(id).toBe(0x7f010000);
    expect(findResource(parseArsc(serializeArsc(t)), 'empty', 'a')).toBe(id);
  });
});
