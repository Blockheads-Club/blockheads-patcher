import { describe, it, expect } from 'vitest';
import { DexError, DexFile, validateDex } from '../../src/dex';
import { editDex, openDexSet } from '../../src/patches/dex-support';
import { fixEmailShareLink, fixWebviewCrash, GUARD_CLASS, MAIL_FIX_CLASS, PatchError, createRegistry, defaultRegistry, JARLPENGUIN_CREDITS, type PatchContext } from '../../src';
import { getEntry, setEntry, type ZipArchive } from '../../src/zip';
import { buildDex, type ClsSpec } from './fixture';

const CLIENT = 'Landroid/webkit/WebViewClient;', WV = 'Landroid/webkit/WebView;', DETAIL = 'Landroid/webkit/RenderProcessGoneDetail;';
const ACTIVITY = 'Lcom/apportable/activity/VerdeActivity;', APP = 'Lcom/apportable/app/VerdeApplication;';
const ret: ClsSpec['virtual'] = [{ name: 'onPageFinished', ret: 'V', params: [WV, 'Ljava/lang/String;'], flags: 1, code: { regs: 4, ins: 3, outs: 0, insns: [0x000e] } }];
const client = (name: string, withHandler = false): ClsSpec => ({
  name, super: CLIENT,
  virtual: [...ret!, ...(withHandler ? [{ name: 'onRenderProcessGone', ret: 'Z', params: [WV, DETAIL], flags: 1, code: { regs: 4, ins: 3, outs: 0, insns: [0x0012, 0x000f] } }] : [])],
});
const host = (name: string, sup: string): ClsSpec => ({ name, super: sup, source: 'H.java', virtual: [{ name: 'other', ret: 'V', params: [], flags: 1, code: { regs: 1, ins: 1, outs: 0, insns: [0x000e] } }] });

const apkCtx = (files: Record<string, Uint8Array>): PatchContext & { zip: ZipArchive; logs: string[] } => {
  const zip: ZipArchive = { entries: [] };
  for (const [name, data] of Object.entries(files)) setEntry(zip, { name, data });
  const logs: string[] = [];
  return { zip, manifest: null as never, info: { packageName: 'com.noodlecake.blockheads', sha256: '' }, markManifestDirty() {}, log: (m) => logs.push(m), logs };
};
const dexOf = (c: PatchContext, name: string): DexFile => DexFile.parse(getEntry(c.zip, name)!.data);

describe('dex-support', () => {
  it('maps editing errors to PatchError and rethrows others', () => {
    expect(() => editDex('p', () => { throw new DexError('boom'); })).toThrow(PatchError);
    expect(() => editDex('p', () => { throw new RangeError('x'); })).toThrow(RangeError);
    expect(editDex('p', () => 5)).toBe(5);
  });
  it('treats missing or malformed dex as unavailable and rethrows unexpected failures', () => {
    expect(openDexSet(apkCtx({}))).toBeUndefined();
    expect(openDexSet(apkCtx({ 'classes.dex': new Uint8Array(200) }))).toBeUndefined();
    const c = apkCtx({ 'classes.dex': buildDex({ classes: [] }) });
    Object.defineProperty(getEntry(c.zip, 'classes.dex')!, 'data', { get() { throw new RangeError('disk'); } });
    expect(() => openDexSet(c)).toThrow(RangeError);
  });
});

describe('fix-webview-crash', () => {
  const files = (): Record<string, Uint8Array> => ({
    'classes.dex': buildDex({ classes: [client('Lg/A;'), host('Lg/Sub;', 'Lg/A;')] }),
    'classes2.dex': buildDex({ classes: [client('Lad/B;'), client('Lad/Done;', true)] }),
  });
  it('is registered with credits', () => {
    expect(defaultRegistry.get('fix-webview-crash')).toBe(fixWebviewCrash);
    expect(fixWebviewCrash.credits).toBe(JARLPENGUIN_CREDITS);
    expect(fixWebviewCrash.optIn).toBeUndefined();
    expect(createRegistry([fixWebviewCrash]).list()).toHaveLength(1);
  });
  it('is incompatible without dex files or without WebViewClient subclasses', () => {
    expect(fixWebviewCrash.detect(apkCtx({}))).toBe('incompatible');
    expect(fixWebviewCrash.detect(apkCtx({ 'classes.dex': buildDex({ classes: [host('La/X;', 'Ljava/lang/Object;')] }) }))).toBe('incompatible');
    expect(() => fixWebviewCrash.apply(apkCtx({}))).toThrow(PatchError);
  });
  it('adds the handler to every direct subclass, plus one guard class, and is idempotent', () => {
    const c = apkCtx(files());
    expect(fixWebviewCrash.detect(c)).toBe('notApplied');
    fixWebviewCrash.apply(c);
    expect(c.logs[0]).toContain('2 classes');
    expect(fixWebviewCrash.detect(c)).toBe('applied');
    for (const n of ['classes.dex', 'classes2.dex']) expect(validateDex(getEntry(c.zip, n)!.data)).toEqual([]);
    const d1 = dexOf(c, 'classes.dex'), d2 = dexOf(c, 'classes2.dex');
    expect(d1.findClass(GUARD_CLASS)!.findMethod('handle', [WV], 'Z')).toMatchObject({ direct: true, hasCode: true });
    expect(d2.findClass(GUARD_CLASS)).toBeUndefined();
    for (const [d, n] of [[d1, 'Lg/A;'], [d2, 'Lad/B;'], [d2, 'Lad/Done;']] as const) expect(d.findClass(n)!.findMethod('onRenderProcessGone', [WV, DETAIL], 'Z')).toBeDefined();
    expect(d1.findClass('Lg/Sub;')!.findMethod('onRenderProcessGone')).toBeUndefined();
    const before = getEntry(c.zip, 'classes.dex')!.data;
    expect(() => fixWebviewCrash.apply(c)).toThrow(/status: applied/);
    expect(getEntry(c.zip, 'classes.dex')!.data).toBe(before);
  });
  it('reuses an existing guard class and is already applied when every client has a handler', () => {
    const c = apkCtx({ 'classes.dex': buildDex({ classes: [client('Lg/A;', true)] }) });
    expect(fixWebviewCrash.detect(c)).toBe('applied');
    const partial = apkCtx(files());
    fixWebviewCrash.apply(partial);
    const extra = buildDex({ classes: [client('Lg/New;')] });
    setEntry(partial.zip, { name: 'classes3.dex', data: extra });
    expect(fixWebviewCrash.detect(partial)).toBe('notApplied');
    fixWebviewCrash.apply(partial);
    expect(dexOf(partial, 'classes3.dex').findClass('Lg/New;')!.findMethod('onRenderProcessGone')).toBeDefined();
    expect(dexOf(partial, 'classes3.dex').findClass(GUARD_CLASS)).toBeUndefined();
  });
});

describe('fix-email-share-link', () => {
  const files = (app = true): Record<string, Uint8Array> => ({
    'classes.dex': buildDex({ classes: [host(ACTIVITY, 'Landroid/app/Activity;'), ...(app ? [host(APP, 'Landroid/app/Application;')] : [])] }),
    'classes2.dex': buildDex({ classes: [host('Lx/Y;', 'Ljava/lang/Object;')] }),
  });
  it('is registered with credits', () => {
    expect(defaultRegistry.get('fix-email-share-link')).toBe(fixEmailShareLink);
    expect(fixEmailShareLink.credits).toBe(JARLPENGUIN_CREDITS);
  });
  it('is incompatible without the game activity', () => {
    expect(fixEmailShareLink.detect(apkCtx({}))).toBe('incompatible');
    expect(fixEmailShareLink.detect(apkCtx({ 'classes.dex': buildDex({ classes: [host(APP, 'Landroid/app/Application;')] }) }))).toBe('incompatible');
  });
  it('overrides startActivity in the activity and the application, once', () => {
    const c = apkCtx(files());
    expect(fixEmailShareLink.detect(c)).toBe('notApplied');
    fixEmailShareLink.apply(c);
    expect(c.logs[0]).toContain('2 classes');
    expect(fixEmailShareLink.detect(c)).toBe('applied');
    expect(validateDex(getEntry(c.zip, 'classes.dex')!.data)).toEqual([]);
    const d = dexOf(c, 'classes.dex');
    const I = 'Landroid/content/Intent;', B = 'Landroid/os/Bundle;';
    for (const n of [ACTIVITY, APP]) {
      const cls = d.findClass(n)!;
      expect(cls.findMethod('startActivity', [I], 'V')).toMatchObject({ hasCode: true, direct: false });
      expect(cls.findMethod('startActivity', [I, B], 'V')).toBeDefined();
    }
    expect(d.findClass(MAIL_FIX_CLASS)!.findMethod('fix', [I], 'V')!.direct).toBe(true);
    expect(() => fixEmailShareLink.apply(c)).toThrow(/status: applied/);
  });
  it('works without an application class and completes a partial state', () => {
    const c = apkCtx(files(false));
    fixEmailShareLink.apply(c);
    expect(fixEmailShareLink.detect(c)).toBe('applied');
    const partial = apkCtx(files());
    fixEmailShareLink.apply(partial);
    // simulate an APK where only the activity was hooked: drop the application hooks by rebuilding that dex
    const d = dexOf(partial, 'classes.dex');
    d.classData(d.findClass(APP)!.def).virtualMethods.length = 0;
    setEntry(partial.zip, { name: 'classes.dex', data: d.serialize() });
    expect(fixEmailShareLink.detect(partial)).toBe('notApplied');
    fixEmailShareLink.apply(partial);
    expect(fixEmailShareLink.detect(partial)).toBe('applied');
    expect(dexOf(partial, 'classes.dex').classNames().filter((n) => n === MAIL_FIX_CLASS)).toHaveLength(1);
  });
});
