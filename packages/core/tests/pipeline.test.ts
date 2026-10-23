import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import {
  loadApk, listPatches, applyPatches, patchApk, patchLoadedApk, PatchError, createRegistry, defaultRegistry, CancelledError,
  fixWelcomePopupDeadlock, MemoryKeystore, generateIdentity, getAttr, findElementsByName, serializeAxml, parseAxml, ANDROID_NS, ValueType,
  THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN, ANDROID_THEME_ATTR_ID, CORE_VERSION,
  type Patch, type PatchContext, type PatchStatus, type SigningIdentity,
} from '../src';
import { readZip, writeZip, setEntry, getEntry, type ZipArchive } from '../src/zip';
import { build, type BEl } from './axml-builder';
import { makeApk, manifestTree, BLOCKHEADS, WEBVIEW } from './synthetic-apk';
import { verifyV2 } from './verify';

const enc = new TextEncoder();
let id: SigningIdentity;
let ks: MemoryKeystore;
beforeAll(async () => { id = await generateIdentity(); ks = new MemoryKeystore(); await ks.set(id); }, 30000);

const themeOf = (apk: Uint8Array): number | undefined => {
  const doc = parseAxml(getEntry(readZip(apk), 'AndroidManifest.xml')!.data);
  const act = findElementsByName(doc, 'activity', WEBVIEW)[0]!;
  return getAttr(act, 'theme', ANDROID_NS, ANDROID_THEME_ATTR_ID)?.data;
};

describe('index', () => {
  it('exposes the version constant', () => expect(CORE_VERSION).toBe('0.2.0'));
});

describe('loadApk', () => {
  it('extracts package, version and the input hash', async () => {
    const bytes = makeApk();
    const apk = await loadApk(bytes);
    expect(apk.info).toEqual({
      packageName: BLOCKHEADS, versionName: '1.7.4', versionCode: 1548230154, sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });
  it('omits version fields the manifest does not declare', async () => {
    const apk = await loadApk(makeApk({ versionName: null, versionCode: null }));
    expect(apk.info).not.toHaveProperty('versionName');
    expect(apk.info).not.toHaveProperty('versionCode');
  });
  it('reports typed errors for non-zips, missing and broken manifests', async () => {
    const code = async (b: Uint8Array) => (await loadApk(b).catch((e) => e)) as PatchError;
    const notZip = await code(enc.encode('this is not a zip file at all'));
    expect(notZip).toBeInstanceOf(PatchError);
    expect(notZip.code).toBe('notApk');
    expect(notZip.params.message).toMatch(/end of central directory/);
    const z: ZipArchive = { entries: [] };
    setEntry(z, { name: 'classes.dex', data: enc.encode('x') });
    const noManifest = await code(writeZip(z));
    expect(noManifest.code).toBe('noManifest');
    expect(noManifest.params.message).toBe('AndroidManifest.xml is missing');
    setEntry(z, { name: 'AndroidManifest.xml', data: enc.encode('plain text, not axml') });
    expect((await code(writeZip(z))).code).toBe('noManifest');
    setEntry(z, { name: 'AndroidManifest.xml', data: build({ name: 'manifest' }) });
    const noPkg = await code(writeZip(z));
    expect(noPkg.code).toBe('noManifest');
    expect(noPkg.message).toMatch(/no package/);
  });
});

describe('fix-welcome-popup-deadlock', () => {
  const ctxOf = (tree: BEl, pkg = BLOCKHEADS) => {
    const doc = parseAxml(build(tree));
    let dirty = false;
    const logs: string[] = [];
    const ctx: PatchContext = {
      zip: { entries: [] }, manifest: doc, info: { packageName: pkg, sha256: '' },
      markManifestDirty: () => { dirty = true; }, log: (m) => logs.push(m),
    };
    return { ctx, doc, isDirty: () => dirty, logs };
  };
  const activity = (attrs: NonNullable<BEl['attrs']>): BEl => ({ name: 'manifest', attrs: [{ name: 'package', str: 'p' }], children: [{ name: 'application', children: [{ name: 'activity', attrs }] }] });
  const name = (v: string) => ({ name: 'name', res: 0x01010003, str: v });
  const theme = (data: number, type = 0x01) => ({ name: 'theme', res: 0x01010000, type, data });

  it('detects and rewrites a different theme reference', () => {
    const { ctx, doc, isDirty, logs } = ctxOf(activity([name(WEBVIEW), theme(0x01030005)]));
    expect(fixWelcomePopupDeadlock.detect(ctx)).toBe('notApplied');
    fixWelcomePopupDeadlock.apply(ctx);
    expect(isDirty()).toBe(true);
    expect(logs[0]).toMatch(/Translucent/);
    expect(fixWelcomePopupDeadlock.detect(ctx)).toBe('applied');
    const re = parseAxml(serializeAxml(doc));
    expect(getAttr(findElementsByName(re, 'activity', WEBVIEW)[0]!, 'theme', ANDROID_NS)!.data).toBe(THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN);
  });

  it('treats a non-reference theme as not applied and converts it', () => {
    const { ctx } = ctxOf(activity([name(WEBVIEW), theme(THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN, 0x10)]));
    expect(fixWelcomePopupDeadlock.detect(ctx)).toBe('notApplied');
    fixWelcomePopupDeadlock.apply(ctx);
    const act = findElementsByName(ctx.manifest, 'activity', WEBVIEW)[0]!;
    expect(getAttr(act, 'theme', ANDROID_NS)!.valueType).toBe(ValueType.Reference);
  });

  it('adds the theme attribute when the activity has none', () => {
    const { ctx, doc } = ctxOf(activity([name(WEBVIEW)]));
    expect(fixWelcomePopupDeadlock.detect(ctx)).toBe('notApplied');
    fixWelcomePopupDeadlock.apply(ctx);
    expect(fixWelcomePopupDeadlock.detect(ctx)).toBe('applied');
    const re = parseAxml(serializeAxml(doc));
    expect(getAttr(findElementsByName(re, 'activity', WEBVIEW)[0]!, 'theme', ANDROID_NS, ANDROID_THEME_ATTR_ID)!.data).toBe(THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN);
  });

  it('refuses to apply twice or to an incompatible manifest', () => {
    const done = ctxOf(activity([name(WEBVIEW), theme(THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN)]));
    expect(fixWelcomePopupDeadlock.detect(done.ctx)).toBe('applied');
    expect(() => fixWelcomePopupDeadlock.apply(done.ctx)).toThrow(/status: applied/);
    const none = ctxOf(activity([name('com.example.Other')]));
    expect(fixWelcomePopupDeadlock.detect(none.ctx)).toBe('incompatible');
    expect(() => fixWelcomePopupDeadlock.apply(none.ctx)).toThrowError(PatchError);
    expect(none.isDirty()).toBe(false);
  });

  it('resolves relative activity names against the package and ignores nameless or foreign activities', () => {
    const rel = ctxOf(activity([name('.BlockheadsWebView'), theme(1)]), 'com.noodlecake.noodlewebview');
    expect(fixWelcomePopupDeadlock.detect(rel.ctx)).toBe('notApplied');
    const wrongPkg = ctxOf(activity([name('.BlockheadsWebView'), theme(1)]), 'com.other');
    expect(fixWelcomePopupDeadlock.detect(wrongPkg.ctx)).toBe('incompatible');
    const noName = ctxOf(activity([theme(1)]));
    expect(fixWelcomePopupDeadlock.detect(noName.ctx)).toBe('incompatible');
    const emptyName = ctxOf(activity([name(''), theme(1)]));
    expect(fixWelcomePopupDeadlock.detect(emptyName.ctx)).toBe('incompatible');
    // the right name, but under a different parent path
    const wrongPath = ctxOf({ name: 'manifest', attrs: [{ name: 'package', str: 'p' }], children: [{ name: 'activity', attrs: [name(WEBVIEW)] }] });
    expect(fixWelcomePopupDeadlock.detect(wrongPath.ctx)).toBe('incompatible');
  });
});

describe('listPatches / applyPatches', () => {
  const stub = (id: string, appliesTo: Patch['appliesTo'], status: PatchStatus = 'notApplied'): Patch & { applied: number } => {
    const p = {
      id, version: 1, nameKey: `n.${id}`, descriptionKey: `d.${id}`, appliesTo, applied: 0,
      detect: () => status,
      apply() { p.applied++; },
    };
    return p;
  };

  it('classifies incompatibility reasons with machine-readable codes', async () => {
    const apk = await loadApk(makeApk());
    const reg = createRegistry([
      stub('ok', { packageName: BLOCKHEADS }),
      stub('pkg', { packageName: 'other' }),
      stub('low', { packageName: BLOCKHEADS, versionCode: { min: 2_000_000_000 } }),
      stub('high', { packageName: BLOCKHEADS, versionCode: { max: 10 } }),
      stub('open', { packageName: BLOCKHEADS, versionCode: {} }),
      stub('name', { packageName: BLOCKHEADS, versionNames: ['9.9'] }),
      stub('nameOk', { packageName: BLOCKHEADS, versionNames: ['1.7.4'] }),
    ]);
    const report = listPatches(apk, reg);
    const by = Object.fromEntries(report.map((r) => [r.patch.id, r]));
    expect(by.ok).toMatchObject({ status: 'notApplied' });
    expect(by.pkg).toMatchObject({ status: 'incompatible', reasonCode: { code: 'wrongPackage', params: { actual: BLOCKHEADS, expected: 'other' } } });
    expect(by.low).toMatchObject({ status: 'incompatible', reasonCode: { code: 'versionTooLow', params: { actual: 1548230154, min: 2_000_000_000 } } });
    expect(by.high).toMatchObject({ status: 'incompatible', reasonCode: { code: 'versionTooHigh', params: { actual: 1548230154, max: 10 } } });
    expect(by.open?.status).toBe('notApplied');
    expect(by.name).toMatchObject({ status: 'incompatible', reasonCode: { code: 'versionNotSupported', params: { actual: '1.7.4' } } });
    expect(by.name?.reason).toMatch(/versionName 1\.7\.4 not supported/);
    expect(by.nameOk?.status).toBe('notApplied');
  });

  it('skips version constraints when the manifest does not declare a version', async () => {
    const apk = await loadApk(makeApk({ versionCode: null, versionName: null }));
    const reg = createRegistry([stub('v', { packageName: BLOCKHEADS, versionCode: { min: 5, max: 6 }, versionNames: ['1'] })]);
    expect(listPatches(apk, reg)[0]!.status).toBe('notApplied');
  });

  it('lists the default registry (welcome fix applicable)', async () => {
    const apk = await loadApk(makeApk());
    const report = listPatches(apk);
    expect(report.map((r) => [r.patch.id, r.status])).toEqual([
      ['fix-welcome-popup-deadlock', 'notApplied'],
      ['fix-system-font-crash', 'incompatible'],
      ['enable-audio-capture', 'notApplied'],
      ['keep-data-on-uninstall', 'notApplied'],
      ['allow-resizing', 'incompatible'],
      ['raise-target-sdk', 'incompatible'],
      ['fix-privacy-setting-dialog', 'incompatible'],
      ['fix-welcome-message-text', 'incompatible'],
      ['fix-invite-email-typo', 'incompatible'],
      ['signs-lowercase', 'incompatible'],
      ['fix-webview-crash', 'incompatible'],
      ['fix-config-change-crash', 'incompatible'],
      ['immersive-fullscreen', 'incompatible'],
      ['fix-email-share-link', 'incompatible'],
      ['fix-join-links', 'incompatible'],
      ['music-with-other-apps', 'incompatible'],
      ['fix-audio-focus-stall', 'incompatible'],
      ['fix-text-activity-freeze', 'incompatible'],
      ['fix-surface-destroy-freeze', 'incompatible'],
      ['fix-background-wakeup', 'incompatible'],
      ['adaptive-icon', 'incompatible'],
      ['sign-editor-centred', 'incompatible'],
      ['lan-multicast', 'incompatible'],
      ['tablet-layout', 'incompatible'],
      ['music-resume', 'incompatible'],
      ['menu-music-loop', 'incompatible'],
      ['world-selection-keep', 'incompatible'],
      ['gamepad-controls', 'incompatible'],
      ['mod-loader', 'incompatible'],
    ]);
    expect(defaultRegistry.get('fix-welcome-popup-deadlock')).toBe(fixWelcomePopupDeadlock);
  });

  it('applies only notApplied patches and reports the rest as skipped', async () => {
    const apk = await loadApk(makeApk());
    const a = stub('a', { packageName: BLOCKHEADS });
    const b = stub('b', { packageName: BLOCKHEADS }, 'applied');
    const c = stub('c', { packageName: 'zzz' });
    const out = applyPatches(apk, ['a', 'b', 'c'], createRegistry([a, b, c]));
    expect(out).toEqual({ applied: ['a'], skipped: [{ id: 'b', status: 'applied' }, { id: 'c', status: 'incompatible' }] });
    expect([a.applied, b.applied, c.applied]).toEqual([1, 0, 0]);
  });

  it('throws a typed error for unknown patch ids', async () => {
    const apk = await loadApk(makeApk());
    const err = (() => { try { applyPatches(apk, ['nope'], createRegistry()); } catch (e) { return e as PatchError; } })()!;
    expect(err).toBeInstanceOf(PatchError);
    expect(err.code).toBe('unknownPatch');
    expect(err.params).toMatchObject({ id: 'nope' });
    expect(() => createRegistry([stub('x', { packageName: 'p' }), stub('x', { packageName: 'p' })])).toThrow(/duplicate patch id: x/);
  });

  it('provides a working context to patches (logging, dirty flag)', async () => {
    const apk = await loadApk(makeApk());
    let seen: PatchContext | undefined;
    const p: Patch = {
      ...stub('ctx', { packageName: BLOCKHEADS }),
      apply(c) { seen = c; c.log('hello'); c.markManifestDirty(); },
    };
    applyPatches(apk, ['ctx'], createRegistry([p]));
    expect(seen!.info).toBe(apk.info);
    expect(seen!.zip).toBe(apk.zip);
    expect(apk.manifestDirty).toBe(true);
  });
});

describe('patchApk end to end (synthetic)', () => {
  it('patches the manifest, signs with v1+v2 and names the output', async () => {
    const input = makeApk();
    expect(themeOf(input)).toBe(0x01030005);
    const stages: string[] = [];
    const res = await patchApk(input, { patchIds: ['fix-welcome-popup-deadlock'], keystore: ks, onProgress: (s) => { if (stages.at(-1) !== s) stages.push(s); } });
    expect(stages).toEqual(['read', 'parse', 'patch', 'write', 'sign', 'done']);
    expect(res.applied).toEqual(['fix-welcome-popup-deadlock']);
    expect(res.skipped).toEqual([]);
    expect(res.suggestedFileName).toBe('blockheads-1.7.4-patched.apk');
    expect(res.certSha256).toBe(createHash('sha256').update(id.certificateDer).digest('hex'));
    expect(themeOf(res.bytes)).toBe(THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN);
    const v2 = verifyV2(res.bytes);
    expect(v2.digestOk && v2.signatureOk).toBe(true);
    // other entries untouched
    const before = readZip(input), after = readZip(res.bytes);
    for (const n of ['classes.dex', 'assets/blob.bin']) expect(Buffer.from(getEntry(after, n)!.data).equals(Buffer.from(getEntry(before, n)!.data))).toBe(true);
    expect(getEntry(after, 'META-INF/BHPATCH.RSA')).toBeDefined();

    // second run on the patched output: nothing to do, manifest left alone
    const again = await patchApk(res.bytes, { patchIds: ['fix-welcome-popup-deadlock'], keystore: ks });
    expect(again.applied).toEqual([]);
    expect(again.skipped).toEqual([{ id: 'fix-welcome-popup-deadlock', status: 'applied' }]);
    expect(Buffer.from(getEntry(readZip(again.bytes), 'AndroidManifest.xml')!.data).equals(Buffer.from(getEntry(after, 'AndroidManifest.xml')!.data))).toBe(true);
    expect(verifyV2(again.bytes).signatureOk).toBe(true);
  }, 60000);

  it('names foreign packages after their package id and handles missing versions', async () => {
    const res = await patchApk(makeApk({ pkg: 'com.example.app', versionName: null }), { patchIds: [], keystore: ks });
    expect(res.suggestedFileName).toBe('com.example.app-patched.apk');
    expect(res.applied).toEqual([]);
  }, 30000);

  it('creates and persists a signing identity on first use', async () => {
    const fresh = new MemoryKeystore();
    const res = await patchApk(makeApk(), { patchIds: [], keystore: fresh });
    const stored = await fresh.get();
    expect(stored).not.toBeNull();
    expect(res.certSha256).toBe(createHash('sha256').update(stored!.certificateDer).digest('hex'));
  }, 30000);

  it('rejects bad input and unknown patches with typed errors', async () => {
    await expect(patchApk(enc.encode('garbage'), { patchIds: [], keystore: ks })).rejects.toMatchObject({ code: 'notApk' });
    await expect(patchApk(makeApk(), { patchIds: ['nope'], keystore: ks })).rejects.toMatchObject({ code: 'unknownPatch' });
  });

  it('honours cancellation before parsing and before patching', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(patchApk(makeApk(), { patchIds: [], keystore: ks, signal: ac.signal })).rejects.toBeInstanceOf(CancelledError);
    const loaded = await loadApk(makeApk());
    await expect(patchLoadedApk(loaded, { patchIds: [], keystore: ks, signal: ac.signal })).rejects.toBeInstanceOf(CancelledError);
  });

  it('patchLoadedApk uses a custom registry and keeps unrelated manifest bytes when nothing changed the manifest', async () => {
    const apk = await loadApk(makeApk());
    const touched: string[] = [];
    const p: Patch = {
      id: 'touch', version: 1, nameKey: 'n', descriptionKey: 'd', appliesTo: { packageName: BLOCKHEADS },
      detect: () => 'notApplied',
      apply(c) { touched.push('x'); setEntry(c.zip, { name: 'assets/new.txt', data: enc.encode('added') }); },
    };
    const res = await patchLoadedApk(apk, { patchIds: ['touch'], keystore: ks, registry: createRegistry([p]) });
    expect(touched).toEqual(['x']);
    const out = readZip(res.bytes);
    expect(new TextDecoder().decode(getEntry(out, 'assets/new.txt')!.data)).toBe('added');
    expect(themeOf(res.bytes)).toBe(0x01030005);
    expect(manifestTree().name).toBe('manifest');
  }, 30000);
});
