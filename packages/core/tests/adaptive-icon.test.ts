import { describe, it, expect } from 'vitest';
import {
  adaptiveIcon, defaultRegistry, JARLPENGUIN_CREDITS, parseAxml, parseArsc, getResource, findResource, configToString, decodePng, encodePng, getEntry,
  loadApk, listPatches, patchApk, readZip, setEntry, writeZip, MemoryKeystore, ANDROID_NS, ValueType, getAttr, findElements, BLOCKHEADS_PACKAGE,
  type PatchContext, type ZipArchive, type Image,
} from '../src';
import { build, type BEl } from './axml-builder';
import { buildArsc, cfg, type BType } from './arsc-builder';
import { manifestTree } from './synthetic-apk';

const ICON_ID = 0x7f010000;
const png = (w = 40, h = 40, a = 255): Uint8Array => {
  const img: Image = { width: w, height: h, rgba: Uint8Array.from({ length: w * h * 4 }, (_, i) => ((i & 3) === 3 ? a : (i >> 2) * 5 + (i & 3) * 40)) };
  return encodePng(img);
};
const str = (s: string) => ({ key: 'icon', value: { str: s } });
const drawable = (configs: { c: number[]; v: ReturnType<typeof str> | null }[]): BType => ({
  name: 'drawable',
  configs: configs.map((x) => ({ config: x.c, entries: [x.v] })),
});
const defaultTypes = (): BType[] => [
  drawable([
    { c: cfg(), v: str('res/drawable/icon.png') },
    { c: cfg({ density: 160, sdk: 4 }), v: str('res/drawable-mdpi/icon.png') },
    { c: cfg({ density: 320, sdk: 4 }), v: str('res/drawable-xhdpi/icon.png') },
  ]),
  { name: 'color', configs: [{ config: cfg(), entries: [{ key: 'other', value: { type: 0x1c, data: 0xff00ff00 } }] }] },
];

interface Opts {
  types?: BType[];
  arsc?: Uint8Array | null;
  iconAttr?: NonNullable<BEl['attrs']>[number] | null;
  app?: boolean;
  files?: Record<string, Uint8Array>;
  extraAppAttrs?: NonNullable<BEl['attrs']>;
}
function makeCtx(o: Opts = {}) {
  const t = manifestTree({});
  const appIdx = t.children!.findIndex((c) => c.name === 'application');
  if (o.app === false) t.children!.splice(appIdx, 1);
  else {
    const attrs: NonNullable<BEl['attrs']> = [...(o.extraAppAttrs ?? [])];
    if (o.iconAttr !== null) attrs.push(o.iconAttr ?? { name: 'icon', res: 0x01010002, type: 0x01, data: ICON_ID });
    t.children![appIdx]!.attrs = attrs;
  }
  const manifest = parseAxml(build(t));
  const zip: ZipArchive = { entries: [] };
  if (o.arsc !== null) setEntry(zip, { name: 'resources.arsc', data: o.arsc ?? buildArsc({ packages: [{ types: o.types ?? defaultTypes() }] }), method: 0 });
  const files = o.files ?? { 'res/drawable/icon.png': png(16), 'res/drawable-mdpi/icon.png': png(24), 'res/drawable-xhdpi/icon.png': png(64) };
  for (const [name, data] of Object.entries(files)) setEntry(zip, { name, data });
  let dirty = 0;
  const logs: string[] = [];
  const ctx: PatchContext = {
    zip, manifest, info: { packageName: BLOCKHEADS_PACKAGE, sha256: '' },
    markManifestDirty: () => { dirty++; }, log: (m) => logs.push(m),
  };
  return { ctx, zip, manifest, dirty: () => dirty, logs };
}
const app = (m: ReturnType<typeof parseAxml>) => findElements(m, (e) => e.name === 'application')[0]!;

describe('adaptive-icon', () => {
  it('is registered, credited, restricted to 1.7.4-1.7.6 and on by default', () => {
    expect(defaultRegistry.get('adaptive-icon')).toBe(adaptiveIcon);
    expect(adaptiveIcon.credits).toBe(JARLPENGUIN_CREDITS);
    expect(adaptiveIcon.appliesTo).toEqual({ packageName: BLOCKHEADS_PACKAGE, versionNames: ['1.7.4', '1.7.5', '1.7.6'] });
    expect(adaptiveIcon.optIn).toBeUndefined();
    expect(adaptiveIcon.nameKey).toBe('patch.adaptive-icon.name');
  });

  it('adds an anydpi-v26 configuration, new resources, files and roundIcon, and is idempotent', () => {
    const t = makeCtx();
    expect(adaptiveIcon.detect(t.ctx)).toBe('notApplied');
    const stored = getEntry(t.zip, 'resources.arsc')!.method;
    adaptiveIcon.apply(t.ctx);
    expect(t.dirty()).toBe(1);
    expect(t.logs[0]).toMatch(/adaptive icon added/);
    expect(adaptiveIcon.detect(t.ctx)).toBe('applied');
    expect(() => adaptiveIcon.apply(t.ctx)).toThrow(/status: applied/);

    const arsc = getEntry(t.zip, 'resources.arsc')!;
    expect(arsc.method).toBe(stored);
    const table = parseArsc(arsc.data);
    // the original configs stay, the new one is added to the same resource id
    const icon = getResource(table, ICON_ID)!;
    expect(icon.configs.map((c) => configToString(c.config))).toEqual(['', 'mdpi-v4', 'xhdpi-v4', 'anydpi-v26']);
    expect(icon.configs[3]!.entry).toMatchObject({ string: 'res/drawable-anydpi-v26/icon.xml' });
    const fg = findResource(table, 'mipmap', 'ic_launcher_foreground')!;
    const bg = findResource(table, 'color', 'ic_launcher_background')!;
    const round = findResource(table, 'mipmap', 'ic_launcher_round')!;
    expect(getResource(table, fg)!.configs.map((c) => configToString(c.config))).toEqual(['nodpi']);
    expect(getResource(table, bg)!.configs[0]!.entry).toMatchObject({ dataType: 0x1c });
    expect(getResource(table, round)!.configs.map((c) => [configToString(c.config), c.entry.kind === 'value' ? c.entry.dataType : 0])).toEqual([['', 1], ['anydpi-v26', 3]]);
    expect(getResource(table, round)!.configs[0]!.entry).toMatchObject({ data: ICON_ID });
    expect(findResource(table, 'color', 'other')).toBe(0x7f020000);

    // adaptive-icon xml
    const xml = parseAxml(getEntry(t.zip, 'res/drawable-anydpi-v26/icon.xml')!.data);
    expect(xml.root.name).toBe('adaptive-icon');
    const [b, f] = xml.root.children.map((c) => getAttr(c, 'drawable', ANDROID_NS, 0x01010199)!);
    expect([b!.valueType, b!.data, f!.valueType, f!.data]).toEqual([ValueType.Reference, bg, ValueType.Reference, fg]);
    // foreground png: 432px canvas, stored
    const fgFile = getEntry(t.zip, 'res/mipmap-nodpi/ic_launcher_foreground.png')!;
    expect(fgFile.method).toBe(0);
    expect(decodePng(fgFile.data).width).toBe(432);
    // the manifest keeps android:icon and gains roundIcon
    const a = app(t.manifest);
    expect(getAttr(a, 'icon', ANDROID_NS, 0x01010002)!.data).toBe(ICON_ID);
    expect(getAttr(a, 'roundIcon', ANDROID_NS, 0x0101052c)).toMatchObject({ valueType: ValueType.Reference, data: round });
  });

  it('samples the background from the highest-density icon and uses a transparent pad for translucent art', () => {
    const solidBlue = (a: number, size: number): Uint8Array => encodePng({ width: size, height: size, rgba: Uint8Array.from({ length: size * size * 4 }, (_, i) => [0, 0, 255, a][i & 3]!) });
    const t = makeCtx({ files: { 'res/drawable/icon.png': png(8), 'res/drawable-mdpi/icon.png': png(8), 'res/drawable-xhdpi/icon.png': solidBlue(120, 32) } });
    adaptiveIcon.apply(t.ctx);
    const table = parseArsc(getEntry(t.zip, 'resources.arsc')!.data);
    expect(getResource(table, findResource(table, 'color', 'ic_launcher_background')!)!.configs[0]!.entry).toMatchObject({ data: 0xff0000ff });
    expect(decodePng(getEntry(t.zip, 'res/mipmap-nodpi/ic_launcher_foreground.png')!.data).rgba[3]).toBe(0);
  });

  it('ignores non-png, bag and nodpi/anydpi entries when picking the source image and prefers real densities', () => {
    const types: BType[] = [{
      name: 'drawable',
      configs: [
        { config: cfg(), entries: [{ key: 'icon', value: { complex: [{ name: 1, type: 0x10, data: 1 }] } }] },
        { config: cfg({ density: 0xfffe, sdk: 20 }), entries: [str('res/drawable-anydpi/icon.xml')] },
        { config: cfg({ density: 0xffff }), entries: [str('res/drawable-nodpi/icon.png')] },
        { config: cfg({ density: 480 }), entries: [str('res/drawable-xxhdpi/icon.png')] },
        { config: cfg({ density: 240 }), entries: [str('res/drawable-hdpi/icon.png')] },
      ],
    }];
    const mk = (n: number) => encodePng({ width: n, height: n, rgba: Uint8Array.from({ length: n * n * 4 }, (_, i) => [200, 0, 0, 255][i & 3]!) });
    const t = makeCtx({ types, files: { 'res/drawable-nodpi/icon.png': mk(8), 'res/drawable-xxhdpi/icon.png': mk(16), 'res/drawable-hdpi/icon.png': mk(8) } });
    expect(adaptiveIcon.detect(t.ctx)).toBe('notApplied');
    const spy = t.logs;
    adaptiveIcon.apply(t.ctx);
    expect(spy[0]).toMatch(/#c80000/);
  });

  it('only uses the nodpi png when nothing else is available', () => {
    const types: BType[] = [drawable([{ c: cfg({ density: 0xffff }), v: str('res/n.png') }])];
    const t = makeCtx({ types, files: { 'res/n.png': png(8) } });
    adaptiveIcon.apply(t.ctx);
    expect(adaptiveIcon.detect(t.ctx)).toBe('applied');
  });

  it('reports applied when the icon already has an adaptive configuration', () => {
    const types = [drawable([{ c: cfg(), v: str('a.png') }, { c: cfg({ density: 0xfffe, sdk: 26 }), v: str('res/x.xml') }])];
    expect(adaptiveIcon.detect(makeCtx({ types }).ctx)).toBe('applied');
    // anydpi without the sdk qualifier is not an adaptive configuration
    const old = [drawable([{ c: cfg(), v: str('a.png') }, { c: cfg({ density: 0xfffe, sdk: 21 }), v: str('res/x.xml') }])];
    expect(adaptiveIcon.detect(makeCtx({ types: old }).ctx)).toBe('notApplied');
    // a table that has anydpi but no sdk is just a density
    const noSdk = [drawable([{ c: cfg(), v: str('a.png') }, { c: cfg({ density: 0xfffe }), v: str('res/x.xml') }])];
    expect(adaptiveIcon.detect(makeCtx({ types: noSdk }).ctx)).toBe('notApplied');
  });

  it('replaces an existing roundIcon attribute', () => {
    const t = makeCtx({ extraAppAttrs: [{ name: 'roundIcon', res: 0x0101052c, type: 0x01, data: 0x7f010009 }] });
    adaptiveIcon.apply(t.ctx);
    const table = parseArsc(getEntry(t.zip, 'resources.arsc')!.data);
    expect(getAttr(app(t.manifest), 'roundIcon', ANDROID_NS, 0x0101052c)!.data).toBe(findResource(table, 'mipmap', 'ic_launcher_round'));
  });

  it('is incompatible when the manifest or resource table cannot be used', () => {
    const detect = (o: Opts) => adaptiveIcon.detect(makeCtx(o).ctx);
    expect(detect({ arsc: null })).toBe('incompatible');
    expect(detect({ app: false })).toBe('incompatible');
    expect(detect({ iconAttr: null })).toBe('incompatible');
    expect(detect({ iconAttr: { name: 'icon', res: 0x01010002, str: 'icon.png' } })).toBe('incompatible');
    expect(detect({ arsc: new Uint8Array(40) })).toBe('incompatible');
    expect(detect({ iconAttr: { name: 'icon', res: 0x01010002, type: 0x01, data: 0x7f0100ff } })).toBe('incompatible');
    expect(detect({ types: [drawable([{ c: cfg(), v: str('res/icon.xml') }])] })).toBe('incompatible');
    expect(detect({ types: [{ name: 'drawable', configs: [{ config: cfg(), entries: [{ key: 'icon', value: { complex: [] } }] }] }] })).toBe('incompatible');
    expect(detect({ types: [{ name: 'drawable', configs: [{ config: cfg(), entries: [{ key: 'icon', value: { type: 0x1c, data: 1 } }] }] }] })).toBe('incompatible');
    expect(() => adaptiveIcon.apply(makeCtx({ arsc: null }).ctx)).toThrow(/status: incompatible/);
  });

  it('fails cleanly without touching the archive when the artwork or the table cannot be used', () => {
    const snapshot = (z: ZipArchive) => z.entries.map((e) => `${e.name}:${e.data.length}`).join('|');
    const run = (o: Opts, re: RegExp) => {
      const t = makeCtx(o);
      const before = snapshot(t.zip);
      expect(() => adaptiveIcon.apply(t.ctx)).toThrow(re);
      expect(snapshot(t.zip)).toBe(before);
      expect(t.dirty()).toBe(0);
    };
    run({ files: { 'res/drawable/icon.png': png(8), 'res/drawable-mdpi/icon.png': png(8) } }, /icon file res\/drawable-xhdpi\/icon.png is missing/);
    run({ files: { 'res/drawable/icon.png': png(8), 'res/drawable-mdpi/icon.png': png(8), 'res/drawable-xhdpi/icon.png': new Uint8Array(30) } }, /cannot read the icon/);
    const clash: BType[] = [...defaultTypes(), { name: 'mipmap', configs: [{ config: cfg(), entries: [{ key: 'ic_launcher_round', value: { type: 0x10, data: 1 } }] }] }];
    run({ types: clash }, /cannot extend the resource table/);
  });
});

describe('adaptive-icon through the pipeline', () => {
  it('patches a synthetic APK end to end', async () => {
    const t = makeCtx();
    const zip = t.zip;
    setEntry(zip, { name: 'AndroidManifest.xml', data: build({ ...manifestTree({}), children: manifestTree({}).children!.map((c) => (c.name === 'application' ? { ...c, attrs: [{ name: 'icon', res: 0x01010002, type: 0x01, data: ICON_ID }] } : c)) }) });
    const apk = writeZip(zip);
    const loaded = await loadApk(apk);
    expect(listPatches(loaded).find((r) => r.patch.id === 'adaptive-icon')!.status).toBe('notApplied');
    const res = await patchApk(apk, { patchIds: ['adaptive-icon'], keystore: new MemoryKeystore() });
    expect(res.applied).toEqual(['adaptive-icon']);
    const out = readZip(res.bytes);
    expect(getEntry(out, 'res/drawable-anydpi-v26/icon.xml')).toBeDefined();
    const back = await loadApk(res.bytes);
    expect(listPatches(back).find((r) => r.patch.id === 'adaptive-icon')!.status).toBe('applied');
    const manifest = parseAxml(getEntry(out, 'AndroidManifest.xml')!.data);
    expect(getAttr(app(manifest), 'roundIcon', ANDROID_NS, 0x0101052c)).toBeDefined();
  });
});
