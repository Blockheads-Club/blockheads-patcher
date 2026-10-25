import { beforeAll, describe, expect, it } from 'vitest';
import {
  CORE_VERSION, MemoryKeystore, PatchError, RECORD_PATH, applyPatches, applyVersioning, buildPackArchive, buildRecord, comparePatchVersions,
  createRegistry, generateIdentity, getEntry, isPatchVersion, listPatches, loadApk, loadPack, makeBooleanFlagPatch, parseRecord, patchApk,
  patchLoadedApk, readRecord, readZip, semverToVersion, serializeRecord, setEntry, versionToSemver, writeRecord,
  type Patch, type PatchContext, type PatchStatus, type PatcherRecord,
} from '../src';
import { BLOCKHEADS, makeApk } from './synthetic-apk';

const enc = new TextEncoder();
const dec = new TextDecoder();
let ks: MemoryKeystore;
beforeAll(async () => { ks = new MemoryKeystore(); await ks.set(await generateIdentity()); }, 30000);

const OUT = 'assets/doc.txt';
const text = (ctx: PatchContext): string | undefined => {
  const e = getEntry(ctx.zip, OUT);
  return e ? dec.decode(e.data) : undefined;
};
interface Opts { upgrade?: boolean; installed?: boolean; label?: boolean; selfOutdated?: boolean }
/**
 * A patch whose output is the text `v<version>` in one asset. Newer versions do not recognise the output of older ones
 * (`incompatible`), the way a real bump that changes the bytes a detect() looks for would.
 */
function docPatch(version: number, o: Opts = {}): Patch & { upgraded: (number | undefined)[] } {
  const p: Patch & { upgraded: (number | undefined)[] } = {
    id: 'doc', version, nameKey: 'n', descriptionKey: 'd', appliesTo: { packageName: BLOCKHEADS }, upgraded: [],
    detect(ctx): PatchStatus {
      const t = text(ctx);
      if (t === undefined) return 'notApplied';
      if (t === `v${version}`) return 'applied';
      return o.selfOutdated ? 'outdated' : 'incompatible';
    },
    apply(ctx) { setEntry(ctx.zip, { name: OUT, data: enc.encode(`v${version}`) }); },
  };
  if (o.upgrade) p.upgrade = (ctx, from) => { p.upgraded.push(from); setEntry(ctx.zip, { name: OUT, data: enc.encode(`v${version}`) }); };
  if (o.installed) p.installedVersion = (ctx) => { const m = /^v(\d+)$/.exec(text(ctx) ?? ''); return m ? Number(m[1]) : undefined; };
  if (o.label) p.versionLabel = (v) => `build ${v}`;
  return p;
}
const reg = (...p: Patch[]) => createRegistry(p);
const patchWith = async (input: Uint8Array, r: ReturnType<typeof reg>, ids = ['doc']) => patchApk(input, { patchIds: ids, keystore: ks, registry: r });
const withoutRecord = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const { writeZip, removeEntry } = await import('../src/zip');
  const z = readZip(bytes);
  removeEntry(z, RECORD_PATH);
  return writeZip(z);
};

describe('version numbers', () => {
  it('maps major.minor.patch onto one comparable integer and back', () => {
    expect(semverToVersion('0.3.1')).toBe(3001);
    expect(semverToVersion('1.2.3')).toBe(1_002_003);
    expect(versionToSemver(1_002_003)).toBe('1.2.3');
    expect(versionToSemver(semverToVersion('12.345.6')!)).toBe('12.345.6');
    for (const bad of ['1.2', '1.2.3.4', 'a.b.c', '1.2.1000', '1.2.3-beta', '']) expect(semverToVersion(bad)).toBeUndefined();
    expect(comparePatchVersions(semverToVersion('0.3.1')!, semverToVersion('0.3.10')!)).toBeLessThan(0);
    expect(comparePatchVersions(semverToVersion('1.0.0')!, semverToVersion('0.999.999')!)).toBeGreaterThan(0);
    expect(comparePatchVersions(2, 2)).toBe(0);
    expect([1, 2, 99].every(isPatchVersion)).toBe(true);
    for (const bad of [0, -1, 1.5, NaN, '1', null, 2 ** 60]) expect(isPatchVersion(bad)).toBe(false);
  });

  it('every built-in patch has a positive integer version', async () => {
    const { defaultRegistry } = await import('../src');
    for (const p of defaultRegistry.list()) expect(isPatchVersion(p.version), p.id).toBe(true);
  });

  it('factories take version, label, installedVersion and upgrade from their spec', () => {
    const upgrade = () => {};
    const p = makeBooleanFlagPatch({
      id: 'f', target: 'application', attrName: 'x', attrId: 1, value: true,
      version: 4, versionLabel: (v) => `r${v}`, installedVersion: () => 2, upgrade,
    });
    expect(p.version).toBe(4);
    expect(p.versionLabel!(4)).toBe('r4');
    expect(p.installedVersion!({} as PatchContext)).toBe(2);
    expect(p.upgrade).toBe(upgrade);
    expect(makeBooleanFlagPatch({ id: 'g', target: 'application', attrName: 'x', attrId: 1, value: true }).version).toBe(1);
    const bare = { id: 'b', version: 1 } as Patch;
    expect(applyVersioning(bare, {})).toBe(bare);
    expect(Object.keys(bare)).toEqual(['id', 'version']);
  });

  it('pack patches carry the pack version; parts above 999 are refused', () => {
    const json = (version: string) => ({
      schemaVersion: 1, id: 'demo', version, name: { en: 'D' }, appliesTo: { packageName: BLOCKHEADS },
      patches: [{ id: 'p', name: { en: 'P' }, description: { en: 'D' }, ops: [{ op: 'file.add', path: 'assets/x', from: 'd/x' }] }],
    });
    const load = (version: string) => loadPack(buildPackArchive({ 'pack.json': enc.encode(JSON.stringify(json(version))), 'd/x': enc.encode('x') }));
    const r = load('1.2.3');
    if (!r.ok) throw new Error('refused');
    const p = r.pack.patches[0]!;
    expect(p.version).toBe(1_002_003);
    expect(p.versionLabel!(p.version)).toBe('1.2.3');
    expect(load('1.2.1000').ok).toBe(false);
  });
});

describe('patcher record', () => {
  const rec = (patches: Record<string, number>): PatcherRecord => ({ schema: 1, patcher: '9.9.9', patches });

  it('is small and deterministic: sorted keys, no whitespace', () => {
    const a = serializeRecord(rec({ b: 2, a: 1, 'pack:x/y': 3 }));
    const b = serializeRecord(rec({ 'pack:x/y': 3, a: 1, b: 2 }));
    expect(dec.decode(a)).toBe('{"patcher":"9.9.9","patches":{"a":1,"b":2,"pack:x/y":3},"schema":1}');
    expect(a).toEqual(b);
  });

  it('round-trips through the archive and replaces an older record', () => {
    const zip = readZip(makeApk());
    expect(readRecord(zip)).toBeUndefined();
    writeRecord(zip, rec({ a: 1 }));
    writeRecord(zip, rec({ a: 2 }));
    expect(zip.entries.filter((e) => e.name === RECORD_PATH)).toHaveLength(1);
    expect(readRecord(zip)).toEqual(rec({ a: 2 }));
  });

  it('treats a damaged record as no record and drops bad entries', () => {
    const p = (s: string | Uint8Array) => parseRecord(typeof s === 'string' ? enc.encode(s) : s);
    expect(p('not json')).toBeUndefined();
    expect(p(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
    expect(p('null')).toBeUndefined();
    expect(p('{"schema":2,"patcher":"1.0.0","patches":{}}')).toBeUndefined();
    expect(p('{"schema":1,"patches":{}}')).toBeUndefined();
    expect(p('{"schema":1,"patcher":"1.0.0"}')).toBeUndefined();
    expect(p('{"schema":1,"patcher":"1.0.0","patches":[1]}')).toBeUndefined();
    expect(p('{"schema":1,"patcher":"1.0.0","patches":{"a":1,"b":0,"c":"2","d":1.5,"e":3}}')).toEqual({ schema: 1, patcher: '1.0.0', patches: { a: 1, e: 3 } });
  });

  it('is written into every patched APK before signing, with the Patcher version', async () => {
    const out = await patchWith(makeApk(), reg(docPatch(1)));
    const zip = readZip(out.bytes);
    expect(readRecord(zip)).toEqual({ schema: 1, patcher: CORE_VERSION, patches: { doc: 1 } });
    expect(getEntry(zip, 'META-INF/BHPATCH.SF')).toBeDefined();
    expect((await loadApk(out.bytes)).record?.patches).toEqual({ doc: 1 });
    // a run that changes nothing still leaves a record
    const again = await patchApk(out.bytes, { patchIds: [], keystore: ks, registry: reg(docPatch(1)) });
    expect(readRecord(readZip(again.bytes))?.patches).toEqual({ doc: 1 });
    expect(await loadApk(makeApk())).not.toHaveProperty('record');
  }, 60000);
});

describe('outdated patches', () => {
  it('v1 output + v2 patch with an upgrade hook: outdated from the record, then upgraded in place', async () => {
    const v1 = await patchWith(makeApk(), reg(docPatch(1)));
    const v2 = docPatch(2, { upgrade: true });
    const apk = await loadApk(v1.bytes);
    const row = listPatches(apk, reg(v2))[0]!;
    expect(row).toMatchObject({ status: 'outdated', fromVersion: 1, canUpgrade: true });

    const out = await patchLoadedApk(apk, { patchIds: ['doc'], keystore: ks, registry: reg(v2) });
    expect(out.applied).toEqual(['doc']);
    expect(out.upgraded).toEqual(['doc']);
    expect(v2.upgraded).toEqual([1]);
    const zip = readZip(out.bytes);
    expect(dec.decode(getEntry(zip, OUT)!.data)).toBe('v2');
    expect(readRecord(zip)?.patches).toEqual({ doc: 2 });
    expect(listPatches(await loadApk(out.bytes), reg(v2))[0]).toEqual({ patch: v2, status: 'applied' });
  }, 60000);

  it('without a record the content decides: unknown old output is not claimed outdated, known old output is', async () => {
    const v1 = await withoutRecord((await patchWith(makeApk(), reg(docPatch(1)))).bytes);
    const apk = await loadApk(v1);
    expect(apk.record).toBeUndefined();
    // detect() says incompatible and nothing else shows the version: no claim
    expect(listPatches(apk, reg(docPatch(2, { upgrade: true })))[0]!.status).toBe('incompatible');
    // the patch can read the old version from the content
    const smart = docPatch(2, { upgrade: true, installed: true });
    expect(listPatches(apk, reg(smart))[0]).toMatchObject({ status: 'outdated', fromVersion: 1, canUpgrade: true });
    const out = await patchLoadedApk(apk, { patchIds: ['doc'], keystore: ks, registry: reg(smart) });
    expect(out.upgraded).toEqual(['doc']);
    expect(smart.upgraded).toEqual([1]);
  }, 60000);

  it('detect() can report outdated itself (no version known)', async () => {
    const v1 = await withoutRecord((await patchWith(makeApk(), reg(docPatch(1)))).bytes);
    const apk = await loadApk(v1);
    const p = docPatch(2, { upgrade: true, selfOutdated: true });
    const row = listPatches(apk, reg(p))[0]!;
    expect(row.status).toBe('outdated');
    expect(row).not.toHaveProperty('fromVersion');
    applyPatches(apk, ['doc'], reg(p));
    expect(p.upgraded).toEqual([undefined]);
    // the record then forgets what it cannot tell
    expect(buildRecord(apk, reg(p)).patches).toEqual({ doc: 2 });
  });

  it('a patch without an upgrade hook says it needs the original APK instead of skipping or double-applying', async () => {
    const v1 = await patchWith(makeApk(), reg(docPatch(1)));
    const apk = await loadApk(v1.bytes);
    const v2 = docPatch(2);
    expect(listPatches(apk, reg(v2))[0]).toMatchObject({ status: 'outdated', fromVersion: 1, canUpgrade: false });
    let err: PatchError | undefined;
    try { applyPatches(apk, ['doc'], reg(v2)); } catch (e) { err = e as PatchError; }
    expect(err).toBeInstanceOf(PatchError);
    expect(err!.code).toBe('needsOriginal');
    expect(err!.message).toMatch(/original game APK/);
    expect(err!.params.id).toBe('doc');
    // nothing was changed
    expect(dec.decode(getEntry(apk.zip, OUT)!.data)).toBe('v1');
  }, 60000);

  it('content wins over the record: current output stays applied, a stale or newer record claims nothing', async () => {
    const v2 = docPatch(2);
    const v1apk = await loadApk((await patchWith(makeApk(), reg(docPatch(1)))).bytes);
    // record says 1, content is the current output: applied
    const current = await loadApk((await patchWith(makeApk(), reg(v2))).bytes);
    current.record = { schema: 1, patcher: '0.0.1', patches: { doc: 1 } };
    expect(listPatches(current, reg(v2))[0]!.status).toBe('applied');
    // record says 2 (current), content shows nothing: notApplied
    const bare = await loadApk(makeApk());
    bare.record = { schema: 1, patcher: '0.0.1', patches: { doc: 2 } };
    expect(listPatches(bare, reg(v2))[0]!.status).toBe('notApplied');
    // record says 3 (newer than this Patcher), content old: incompatible, no outdated claim
    v1apk.record = { schema: 1, patcher: '9.0.0', patches: { doc: 3 } };
    expect(listPatches(v1apk, reg(v2))[0]!.status).toBe('incompatible');
  }, 60000);

  it('keeps older records for patches it cannot update, forgets removed output, and ignores other packages', async () => {
    const v1 = await patchWith(makeApk(), reg(docPatch(1)));
    const apk = await loadApk(v1.bytes);
    apk.record = { schema: 1, patcher: '0.0.1', patches: { doc: 1, gone: 5, 'pack:x/y': 2 } };
    const foreign: Patch = { ...docPatch(1), id: 'foreign', appliesTo: { packageName: 'other.pkg' } };
    const missing: Patch = { ...docPatch(1), id: 'gone', detect: () => 'notApplied' };
    const stuck: Patch = { ...docPatch(1), id: 'pack:x/y', detect: () => 'incompatible' };
    // outdated: kept at the version found; unknown ids and incompatible content keep their entry; notApplied drops it
    expect(buildRecord(apk, reg(docPatch(2), foreign, missing, stuck)).patches).toEqual({ doc: 1, 'pack:x/y': 2 });
    expect(buildRecord(apk, reg(docPatch(1), foreign)).patches).toEqual({ doc: 1, gone: 5, 'pack:x/y': 2 });
  }, 60000);

  it('patching a fully current APK still works (re-sign) and keeps the record', async () => {
    const r = reg(docPatch(1));
    const first = await patchWith(makeApk(), r);
    const again = await patchApk(first.bytes, { patchIds: [], keystore: ks, registry: r });
    expect(again.applied).toEqual([]);
    expect(again.upgraded).toEqual([]);
    expect(again.certSha256).toBe(first.certSha256);
    expect(readRecord(readZip(again.bytes))?.patches).toEqual({ doc: 1 });
  }, 60000);
});
