import { afterEach, describe, expect, it } from 'vitest';
import { DexFile } from '../../src/dex';
import {
  MOD_LOADER_LIB_PATH, MOD_LOADER_LISTENER, MOD_LOADER_LISTENER_CLASS, MOD_LOADER_PIN, PatchError, defaultRegistry,
  modLoader, modLoaderArtifact, KNOWN_LOADER_LIBS, semverToVersion, modLoaderFileName, parseModLoaderZip, setModLoaderArtifact, sha256HexSync,
  RESERVED_CLASS_PREFIXES, type ModLoaderPin, type PatchContext,
} from '../../src';
import { findElementsByName, getAttr, parseAxml } from '../../src/axml';
import { getEntry, setEntry, writeZip, type ZipArchive } from '../../src/zip';
import { build, type BEl } from '../axml-builder';
import { buildDex, type ClsSpec } from './fixture';

const LIBS_META = 'android.app.libs', LISTENERS_META = 'apportable.app.lifecycle_listeners';
const LIFECYCLE = 'Lcom/apportable/Lifecycle$Listener;';
const ELF = (tag = 0): Uint8Array => {
  const b = new Uint8Array(64);
  b.set([0x7f, 0x45, 0x4c, 0x46, 1, 1], 0);
  b.set([3, 0, 40, 0], 16);
  b[40] = tag;
  return b;
};
const OURS: ClsSpec = { name: MOD_LOADER_LISTENER_CLASS, super: 'Ljava/lang/Object;' };
const OURS2: ClsSpec = { name: 'Lcom/blockheadsclub/modloader/Kit;', super: 'Ljava/lang/Object;' };
const loaderDex = (extra: ClsSpec[] = []): Uint8Array => buildDex({ classes: [OURS, OURS2, ...extra] });

interface ZipSpec { version?: string; lib?: Uint8Array; dex?: Uint8Array; json?: string | null; libMeta?: object; drop?: string }
function loaderZip(s: ZipSpec = {}): Uint8Array {
  const lib = s.lib ?? ELF(), dex = s.dex ?? loaderDex();
  const json = s.json !== undefined ? s.json : JSON.stringify({
    version: s.version ?? '0.1.0', listener: MOD_LOADER_LISTENER, libName: 'bhmodloader',
    lib: s.libMeta ?? { sha256: sha256HexSync(lib), size: lib.length }, dex: { sha256: sha256HexSync(dex), size: dex.length },
  });
  const zip: ZipArchive = { entries: [] };
  if (json !== null) setEntry(zip, { name: 'loader.json', data: new TextEncoder().encode(json), method: 0 });
  if (s.drop !== 'lib') setEntry(zip, { name: 'libbhmodloader.so', data: lib, method: 0 });
  if (s.drop !== 'dex') setEntry(zip, { name: 'classes.dex', data: dex, method: 0 });
  return writeZip(zip);
}
const pinOf = (zip: Uint8Array, version = '0.1.0'): ModLoaderPin => ({ version, url: 'https://x/y.zip', sha256: sha256HexSync(zip), size: zip.length, libSha256: '', dexSha256: '' });

type Meta = { name: string; value?: string | number };
const meta = (m: Meta): BEl => ({
  name: 'meta-data',
  attrs: [{ name: 'name', res: 0x01010003, str: m.name }, ...(m.value === undefined ? [] : [typeof m.value === 'string' ? { name: 'value', res: 0x01010024, str: m.value } : { name: 'value', res: 0x01010024, type: 0x10, data: m.value }])],
});
const tree = (metas: Meta[] = [{ name: LIBS_META, value: 'v Application' }, { name: LISTENERS_META, value: 'com.apportable.iap.ApportableIAP' }]): BEl => ({
  name: 'manifest', attrs: [{ name: 'package', str: 'com.noodlecake.blockheads' }], children: [{ name: 'application', children: metas.map(meta) }],
});
const IFACE: ClsSpec = { name: LIFECYCLE, super: 'Ljava/lang/Object;', flags: 0x601 };
const gameDex = () => ({ 'classes.dex': buildDex({ classes: [IFACE] }), 'classes2.dex': buildDex({ classes: [{ name: 'Lcom/x/A;', super: 'Ljava/lang/Object;' }] }) });

function ctxOf(files: Record<string, Uint8Array>, t: BEl = tree()): PatchContext & { logs: string[]; dirty: () => number } {
  const zip: ZipArchive = { entries: [] };
  for (const [name, data] of Object.entries(files)) setEntry(zip, { name, data });
  const logs: string[] = [];
  let dirty = 0;
  return { zip, manifest: parseAxml(build(t)), info: { packageName: 'com.noodlecake.blockheads', sha256: '' }, markManifestDirty: () => { dirty++; }, log: (m) => logs.push(m), logs, dirty: () => dirty };
}
const metaOf = (c: PatchContext, name: string): string => getAttr(findElementsByName(c.manifest, 'meta-data', name)[0]!, 'value', undefined, 0x01010024)!.stringValue!;

afterEach(() => setModLoaderArtifact(null));

describe('mod loader zip', () => {
  it('parses a build and checks it against a pin', () => {
    const z = loaderZip();
    const a = parseModLoaderZip(z, pinOf(z));
    expect(a.version).toBe('0.1.0');
    expect(a.lib).toEqual(ELF());
    expect(a.libSha256).toBe(sha256HexSync(ELF()));
    expect(parseModLoaderZip(z, null).dex.length).toBeGreaterThan(0);
    expect(modLoaderFileName()).toBe(`bhmod-android-loader-${MOD_LOADER_PIN.version}.zip`);
    expect(MOD_LOADER_PIN.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses anything else', () => {
    const z = loaderZip();
    const bad = (bytes: Uint8Array, pin: ModLoaderPin | null, re: RegExp) => {
      let err: unknown;
      try { parseModLoaderZip(bytes, pin); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(PatchError);
      expect((err as PatchError).code).toBe('modLoaderUnavailable');
      expect((err as Error).message).toMatch(re);
    };
    bad(z, { ...pinOf(z), sha256: '0'.repeat(64) }, /pinned build/);
    bad(new Uint8Array([1, 2, 3]), null, /not a zip/);
    bad(loaderZip({ json: null }), null, /loader.json is missing/);
    bad(loaderZip({ json: '{nope' }), null, /not JSON/);
    bad(loaderZip({ json: '{"version": 1}' }), null, /no major.minor.patch/);
    bad(loaderZip({ version: 'x.y' }), null, /no major.minor.patch/);
    bad(loaderZip({ json: '{"version": "0.1.0"}' }), null, /does not describe/);
    const v2 = loaderZip({ version: '0.2.0' });
    bad(v2, pinOf(v2, '0.1.0'), /pin says 0.1.0/);
    bad(loaderZip({ drop: 'lib' }), null, /libbhmodloader.so is missing/);
    bad(loaderZip({ drop: 'dex' }), null, /classes.dex is missing/);
    bad(loaderZip({ libMeta: { sha256: 'x', size: 64 } }), null, /libbhmodloader.so does not match/);
    bad(loaderZip({ lib: new Uint8Array(64) }), null, /not a 32-bit ARM/);
    bad(loaderZip({ dex: new Uint8Array(200) }), null, /classes.dex is not valid/);
    const noLib = JSON.stringify({ version: '0.1.0', listener: MOD_LOADER_LISTENER, libName: 'bhmodloader' });
    bad(loaderZip({ json: noLib }), null, /does not match/);
  });
});

describe('mod-loader patch', () => {
  it('is on by default, in the default registry, and needs the loader files to apply', () => {
    expect(modLoader.optIn).toBeUndefined();
    expect(defaultRegistry.get('mod-loader')).toBe(modLoader);
    expect(RESERVED_CLASS_PREFIXES).toContain('Lcom/blockheadsclub/modloader/');
    const c = ctxOf(gameDex());
    expect(modLoader.detect(c)).toBe('notApplied');
    expect(() => modLoader.apply(c)).toThrow(/not loaded/);
  });

  it('adds the stored library, both meta-data names and the dex, once', () => {
    setModLoaderArtifact(parseModLoaderZip(loaderZip(), null));
    expect(modLoaderArtifact()?.version).toBe('0.1.0');
    const c = ctxOf(gameDex());
    modLoader.apply(c);
    expect(modLoader.detect(c)).toBe('applied');
    expect(c.dirty()).toBe(1);
    expect(c.logs[0]).toContain('0.1.0');
    const lib = getEntry(c.zip, MOD_LOADER_LIB_PATH)!;
    expect(lib.method).toBe(0);
    expect(lib.data).toEqual(ELF());
    expect(metaOf(c, LIBS_META)).toBe('v Application bhmodloader');
    expect(metaOf(c, LISTENERS_META)).toBe(`com.apportable.iap.ApportableIAP ${MOD_LOADER_LISTENER}`);
    expect(DexFile.parse(getEntry(c.zip, 'classes3.dex')!.data).findClass(MOD_LOADER_LISTENER_CLASS)).toBeDefined();
    expect(() => modLoader.apply(c)).toThrow(/status: applied/);
    // without a build at hand, the pinned build is the reference: a different installed loader is out of date
    setModLoaderArtifact(null);
    expect(modLoader.detect(c)).toBe('outdated');
    // ... and the pinned build itself counts as applied without loading anything
    const pin = MOD_LOADER_PIN, saved = { lib: pin.libSha256, dex: pin.dexSha256 };
    try {
      pin.libSha256 = sha256HexSync(ELF());
      pin.dexSha256 = sha256HexSync(loaderDex());
      expect(modLoader.detect(c)).toBe('applied');
    } finally { pin.libSha256 = saved.lib; pin.dexSha256 = saved.dex; }
  });

  it('updates an older loader in place', () => {
    const old = parseModLoaderZip(loaderZip({ lib: ELF(1), version: '0.0.9' }), null);
    setModLoaderArtifact(old);
    const c = ctxOf(gameDex());
    modLoader.apply(c);
    const newDex = loaderDex([{ name: 'Lcom/blockheadsclub/modloader/New;', super: 'Ljava/lang/Object;' }]);
    setModLoaderArtifact(parseModLoaderZip(loaderZip({ lib: ELF(2), dex: newDex }), null));
    expect(modLoader.detect(c)).toBe('outdated');
    expect(() => modLoader.apply(c)).toThrow(/status: outdated/);
    modLoader.upgrade!(c, undefined);
    expect(c.dirty()).toBe(1);
    expect(getEntry(c.zip, MOD_LOADER_LIB_PATH)!.data).toEqual(ELF(2));
    expect(getEntry(c.zip, 'classes3.dex')!.data).toEqual(newDex);
    expect(getEntry(c.zip, 'classes4.dex')).toBeUndefined();
    expect(modLoader.detect(c)).toBe('applied');
    expect(() => modLoader.upgrade!(c, undefined)).toThrow(/status: applied/);
  });

  it('versions follow the loader build and the lib hash names an older one', () => {
    expect(modLoader.version).toBe(semverToVersion(MOD_LOADER_PIN.version));
    expect(modLoader.versionLabel!(modLoader.version)).toBe(MOD_LOADER_PIN.version);
    setModLoaderArtifact(parseModLoaderZip(loaderZip({ version: '0.2.5' }), null));
    expect(modLoader.version).toBe(2005);
    const c = ctxOf(gameDex());
    expect(modLoader.installedVersion!(c)).toBeUndefined();
    setEntry(c.zip, { name: MOD_LOADER_LIB_PATH, data: ELF(9) });
    expect(modLoader.installedVersion!(c)).toBeUndefined();
    // a lib the Patcher shipped earlier (the real table lists the shipped builds' hashes)
    expect(Object.values(KNOWN_LOADER_LIBS)).toEqual(['0.3.0', '0.3.1', MOD_LOADER_PIN.version]);
    const saved = KNOWN_LOADER_LIBS as Record<string, string>;
    saved[sha256HexSync(ELF(9))] = '0.1.5';
    try { expect(modLoader.installedVersion!(c)).toBe(semverToVersion('0.1.5')); } finally { delete saved[sha256HexSync(ELF(9))]; }
  });

  it('a stale dex alone (library missing or current) is outdated too', () => {
    setModLoaderArtifact(parseModLoaderZip(loaderZip(), null));
    const c = ctxOf(gameDex());
    modLoader.apply(c);
    const staleDex = loaderDex([{ name: 'Lcom/blockheadsclub/modloader/Old;', super: 'Ljava/lang/Object;' }]);
    setEntry(c.zip, { name: 'classes3.dex', data: staleDex });
    expect(modLoader.detect(c)).toBe('outdated');
    c.zip.entries = c.zip.entries.filter((e) => e.name !== MOD_LOADER_LIB_PATH);
    expect(modLoader.detect(c)).toBe('outdated');
    modLoader.upgrade!(c, undefined);
    expect(modLoader.detect(c)).toBe('applied');
  });

  it('completes partial states and refuses odd APKs', () => {
    setModLoaderArtifact(parseModLoaderZip(loaderZip(), null));
    // names present, files missing: only the files are added
    const a = ctxOf(gameDex(), tree([{ name: LIBS_META, value: 'v bhmodloader' }, { name: LISTENERS_META, value: MOD_LOADER_LISTENER }]));
    modLoader.apply(a);
    expect(a.dirty()).toBe(0);
    expect(modLoader.detect(a)).toBe('applied');
    // our class inside a game dex: we would have to edit a dex we do not own
    const mixed = ctxOf({ 'classes.dex': buildDex({ classes: [IFACE, OURS] }) });
    expect(modLoader.detect(mixed)).toBe('incompatible');
    // gaps in the dex numbering
    const gap = ctxOf({ 'classes.dex': buildDex({ classes: [IFACE] }), 'classes3.dex': buildDex({ classes: [OURS2] }) });
    expect(() => modLoader.apply(gap)).toThrow(/numbered consecutively/);
    // no meta-data / no listener interface
    expect(modLoader.detect(ctxOf(gameDex(), tree([{ name: LIBS_META, value: 'v' }])))).toBe('incompatible');
    const L = { name: LISTENERS_META, value: 'x' };
    expect(modLoader.detect(ctxOf(gameDex(), tree([{ name: LIBS_META }, L])))).toBe('incompatible');
    expect(modLoader.detect(ctxOf(gameDex(), tree([{ name: LIBS_META, value: 7 }, L])))).toBe('incompatible');
    expect(modLoader.detect(ctxOf(gameDex(), tree([{ name: LIBS_META, value: 'v' }, { name: LIBS_META, value: 'v' }, L])))).toBe('incompatible');
    expect(modLoader.detect(ctxOf({ 'classes.dex': buildDex({ classes: [OURS2] }) }))).toBe('incompatible');
    expect(() => modLoader.apply(ctxOf({}))).toThrow(PatchError);
  });
});
