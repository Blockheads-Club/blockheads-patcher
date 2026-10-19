import { describe, it, expect } from 'vitest';
import {
  parseAxml, getAttr, findElements, ANDROID_NS, ValueType, PatchError, createRegistry, defaultRegistry, JARLPENGUIN_CREDITS,
  enableAudioCapture, keepDataOnUninstall, allowResizing, raiseTargetSdk, makeBooleanFlagPatch, ATTR, MAIN_ACTIVITY, BLOCKHEADS_PACKAGE,
  TARGET_SDK, listPatches, loadApk, type Patch, type PatchContext,
} from '../src';
import { build, type BEl } from './axml-builder';
import { makeApk } from './synthetic-apk';

const NAME = { name: 'name', res: 0x01010003 };
const bool = (name: string, res: number, v: boolean) => ({ name, res, type: 0x12, data: v ? 0xffffffff : 0 });
interface Opts { appAttrs?: NonNullable<BEl['attrs']>; actAttrs?: NonNullable<BEl['attrs']>; actName?: string | null; sdk?: BEl | null; app?: boolean }
const tree = (o: Opts = {}): BEl => ({
  name: 'manifest',
  attrs: [{ name: 'package', str: BLOCKHEADS_PACKAGE }],
  children: [
    ...(o.sdk === null ? [] : [o.sdk ?? { name: 'uses-sdk', attrs: [{ name: 'targetSdkVersion', res: 0x01010270, type: 0x10, data: 27 }] }]),
    ...(o.app === false ? [] : [{
      name: 'application', attrs: o.appAttrs ?? [],
      children: [
        { name: 'activity', attrs: [{ ...NAME, str: 'com.other.Activity' }] },
        ...(o.actName === null ? [] : [{ name: 'activity', attrs: [{ ...NAME, str: o.actName ?? MAIN_ACTIVITY }, ...(o.actAttrs ?? [])] }]),
      ],
    }]),
  ],
});
const ctxOf = (t: BEl) => {
  const doc = parseAxml(build(t));
  let dirty = 0;
  const logs: string[] = [];
  const ctx: PatchContext = { zip: { entries: [] }, manifest: doc, info: { packageName: BLOCKHEADS_PACKAGE, sha256: '' },
    markManifestDirty: () => { dirty++; }, log: (m) => logs.push(m) };
  return { ctx, doc, dirty: () => dirty, logs };
};
const app = (doc: ReturnType<typeof parseAxml>) => findElements(doc, (e) => e.name === 'application')[0]!;
const act = (doc: ReturnType<typeof parseAxml>) => findElements(doc, (e) => e.name === 'activity')[1]!;
const attr = (el: ReturnType<typeof app>, n: string, id: number) => getAttr(el, n, ANDROID_NS, id);

const applicationCases: [Patch, string, number][] = [
  [enableAudioCapture, 'allowAudioPlaybackCapture', ATTR.allowAudioPlaybackCapture],
  [keepDataOnUninstall, 'hasFragileUserData', ATTR.hasFragileUserData],
];

describe.each(applicationCases)('application flag patch %#', (patch, name, id) => {
  it('adds the attribute, is idempotent and credited', () => {
    const t = ctxOf(tree());
    expect(patch.detect(t.ctx)).toBe('notApplied');
    patch.apply(t.ctx);
    expect(t.dirty()).toBe(1);
    expect(t.logs[0]).toContain(name);
    expect(patch.detect(t.ctx)).toBe('applied');
    const a = attr(app(t.doc), name, id)!;
    expect([a.valueType, a.data]).toEqual([ValueType.IntBoolean, 0xffffffff]);
    expect(() => patch.apply(t.ctx)).toThrow(/status: applied/);
    expect(patch.credits).toBe(JARLPENGUIN_CREDITS);
    expect(patch.optIn).toBeUndefined();
  });
  it('flips an existing false value and replaces a wrongly typed one', () => {
    const f = ctxOf(tree({ appAttrs: [bool(name, id, false)] }));
    expect(patch.detect(f.ctx)).toBe('notApplied');
    patch.apply(f.ctx);
    expect(patch.detect(f.ctx)).toBe('applied');
    const w = ctxOf(tree({ appAttrs: [{ name, res: id, type: 0x10, data: 1 }] }));
    expect(patch.detect(w.ctx)).toBe('notApplied');
    patch.apply(w.ctx);
    expect(attr(app(w.doc), name, id)!.valueType).toBe(ValueType.IntBoolean);
  });
  it('is incompatible without an application element', () => {
    const t = ctxOf(tree({ app: false }));
    expect(patch.detect(t.ctx)).toBe('incompatible');
    expect(() => patch.apply(t.ctx)).toThrowError(PatchError);
  });
});

describe('allow-resizing', () => {
  it('sets resizeableActivity=true on the game activity only', () => {
    const t = ctxOf(tree());
    expect(allowResizing.detect(t.ctx)).toBe('notApplied');
    allowResizing.apply(t.ctx);
    expect(allowResizing.detect(t.ctx)).toBe('applied');
    const a = attr(act(t.doc), 'resizeableActivity', ATTR.resizeableActivity)!;
    expect([a.valueType, a.data]).toEqual([ValueType.IntBoolean, 0xffffffff]);
    expect(attr(findElements(t.doc, (e) => e.name === 'activity')[0]!, 'resizeableActivity', ATTR.resizeableActivity)).toBeUndefined();
  });
  it('the flag helper also writes false', () => {
    const off = makeBooleanFlagPatch({ id: 'off', target: { activity: MAIN_ACTIVITY }, attrName: 'resizeableActivity', attrId: ATTR.resizeableActivity, value: false });
    const t = ctxOf(tree());
    off.apply(t.ctx);
    expect(attr(act(t.doc), 'resizeableActivity', ATTR.resizeableActivity)!.data).toBe(0);
    expect(off.detect(t.ctx)).toBe('applied');
  });
  it('repairs resizeableActivity=false (earlier patch) and resolves relative names', () => {
    const t = ctxOf(tree({ actAttrs: [bool('resizeableActivity', ATTR.resizeableActivity, false)] }));
    expect(allowResizing.detect(t.ctx)).toBe('notApplied');
    allowResizing.apply(t.ctx);
    expect(allowResizing.detect(t.ctx)).toBe('applied');
    const rel = ctxOf(tree({ actName: '.nothing' }));
    expect(allowResizing.detect(rel.ctx)).toBe('incompatible');
    const relOk = makeBooleanFlagPatch({ id: 'x', target: { activity: `${BLOCKHEADS_PACKAGE}.Rel` }, attrName: 'a', attrId: 1, value: true });
    expect(relOk.detect(ctxOf(tree({ actName: '.Rel' })).ctx)).toBe('notApplied');
    expect(relOk.detect(ctxOf(tree({ actName: null })).ctx)).toBe('incompatible');
  });
});

describe('raise-target-sdk', () => {
  it('raises 27 to 28 and enables cleartext traffic', () => {
    const t = ctxOf(tree());
    expect(raiseTargetSdk.detect(t.ctx)).toBe('notApplied');
    raiseTargetSdk.apply(t.ctx);
    expect(raiseTargetSdk.detect(t.ctx)).toBe('applied');
    const sdk = findElements(t.doc, (e) => e.name === 'uses-sdk')[0]!;
    expect(getAttr(sdk, 'targetSdkVersion', ANDROID_NS, 0x01010270)!.data).toBe(TARGET_SDK);
    expect(attr(app(t.doc), 'usesCleartextTraffic', ATTR.usesCleartextTraffic)!.data).toBe(0xffffffff);
    expect(TARGET_SDK).toBe(28);
    expect(attr(app(t.doc), 'requestLegacyExternalStorage', ATTR.requestLegacyExternalStorage)).toBeUndefined();
    expect(raiseTargetSdk.optIn).toBe(true);
    expect(raiseTargetSdk.credits).toBe(JARLPENGUIN_CREDITS);
    expect(() => raiseTargetSdk.apply(t.ctx)).toThrow(/status: applied/);
  });
  it('keeps a higher target and only adds the compatibility flags', () => {
    const t = ctxOf(tree({ sdk: { name: 'uses-sdk', attrs: [{ name: 'targetSdkVersion', res: 0x01010270, type: 0x11, data: 33 }] } }));
    expect(raiseTargetSdk.detect(t.ctx)).toBe('notApplied');
    raiseTargetSdk.apply(t.ctx);
    const sdk = findElements(t.doc, (e) => e.name === 'uses-sdk')[0]!;
    expect(getAttr(sdk, 'targetSdkVersion', ANDROID_NS, 0x01010270)!.data).toBe(33);
    expect(raiseTargetSdk.detect(t.ctx)).toBe('applied');
  });
  it('is incompatible without a numeric targetSdkVersion or an application', () => {
    expect(raiseTargetSdk.detect(ctxOf(tree({ sdk: null })).ctx)).toBe('incompatible');
    expect(raiseTargetSdk.detect(ctxOf(tree({ sdk: { name: 'uses-sdk' } })).ctx)).toBe('incompatible');
    expect(raiseTargetSdk.detect(ctxOf(tree({ sdk: { name: 'uses-sdk', attrs: [{ name: 'targetSdkVersion', res: 0x01010270, str: 'S' }] } })).ctx)).toBe('incompatible');
    expect(raiseTargetSdk.detect(ctxOf(tree({ app: false })).ctx)).toBe('incompatible');
  });
});

describe('makeBooleanFlagPatch', () => {
  it('carries optional credits and opt-in', () => {
    const p = makeBooleanFlagPatch({ id: 'y', target: 'application', attrName: 'a', attrId: 1, value: true, optIn: true, credits: JARLPENGUIN_CREDITS });
    expect([p.optIn, p.credits]).toEqual([true, JARLPENGUIN_CREDITS]);
  });
});

describe('registration', () => {
  it('registers every manifest patch with unique ids and credits', async () => {
    const ids = defaultRegistry.list().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['enable-audio-capture', 'keep-data-on-uninstall', 'allow-resizing', 'raise-target-sdk']));
    expect(() => createRegistry(defaultRegistry.list())).not.toThrow();
    const apk = await loadApk(makeApk());
    expect(listPatches(apk).find((r) => r.patch.id === 'enable-audio-capture')?.status).toBe('notApplied');
    expect(JARLPENGUIN_CREDITS.url).toBe('https://github.com/JarlPenguin/blockheads-android-patches');
  });
});
