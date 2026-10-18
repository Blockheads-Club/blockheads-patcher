import { describe, it, expect } from 'vitest';
import { ACC, CodeBuilder, DexError, DexFile, decodeAll, validateDex } from '../../src/dex';
import { calleeOf, callsClass, describeMethod, insnsOf } from '../../src/patches/dex-support';
import {
  GRAVITY_CENTRED, GRAVITY_ORIGINAL, MULTICAST_CLASS, MULTICAST_PERMISSION, PatchError, TABLET_CLASS, defaultRegistry, JARLPENGUIN_CREDITS,
  lanMulticast, signEditorCentred, tabletLayout, type PatchContext,
} from '../../src';
import { ANDROID_NS, findElementsByName, getAttr, parseAxml } from '../../src/axml';
import { getEntry, setEntry, type ZipArchive } from '../../src/zip';
import { build, type BEl } from '../axml-builder';
import { buildDex, type ClsSpec, type MSpec, type Unit } from './fixture';

const dexOf = (ctx: PatchContext, name = 'classes.dex'): DexFile => DexFile.parse(getEntry(ctx.zip, name)!.data);
const code = (insns: Unit[], regs = 2, ins = 1, outs = 2): MSpec['code'] => ({ regs, ins, outs, insns });
const RET: Unit[] = [0x000e];

const manifestTree = (perms: string[] = ['android.permission.INTERNET'], root = 'manifest'): BEl => ({
  name: root,
  attrs: [{ name: 'package', str: 'com.noodlecake.blockheads' }],
  children: [...perms.map((p) => ({ name: 'uses-permission', attrs: [{ name: 'name', res: 0x01010003, str: p }] })), { name: 'application' }],
});
function apkCtx(files: Record<string, Uint8Array>, tree: BEl = manifestTree()): PatchContext & { logs: string[]; dirty: () => number } {
  const zip: ZipArchive = { entries: [] };
  for (const [name, data] of Object.entries(files)) setEntry(zip, { name, data });
  const logs: string[] = [];
  let dirty = 0;
  return { zip, manifest: parseAxml(build(tree)), info: { packageName: 'com.noodlecake.blockheads', sha256: '' }, markManifestDirty: () => { dirty++; }, log: (m) => logs.push(m), logs, dirty: () => dirty };
}

describe('DexClass editing primitives', () => {
  const spec = (): ClsSpec => ({
    name: 'Lt/A;', super: 'Ljava/lang/Object;',
    virtual: [
      { name: 'plain', ret: 'V', params: [], flags: 1, code: code([0x0012, 0x000e], 2, 1, 0) },
      { name: 'guarded', ret: 'V', params: [], flags: 1, code: { regs: 2, ins: 1, outs: 0, insns: [0x0012, 0x000e, 0x000d, 0x000e], tries: [{ start: 0, count: 2, handler: 0 }, { start: 2, count: 1, handler: 1 }], handlers: [{ catches: [{ type: 'Ljava/lang/Throwable;', addr: 2 }] }, { catches: [], catchAll: 2 }] } },
      { name: 'abs', ret: 'V', params: [], flags: 0x401 },
    ],
  });
  const load = (): DexFile => DexFile.parse(buildDex({ classes: [spec()] }));
  it('exposes code and patches instructions in place', () => {
    const d = load(), cls = d.findClass('Lt/A;')!;
    expect(cls.codeOf(cls.findMethod('abs')!)).toBeUndefined();
    expect(cls.codeOf(cls.findMethod('plain')!)!.insns[0]).toBe(0x0012);
    cls.patchInsns(cls.findMethod('plain')!, (u) => { u[0] = 0x1012; });
    expect(d.dirty).toBe(true);
    expect(DexFile.parse(d.serialize()).findClass('Lt/A;')!.codeOf(cls.findMethod('plain')!)!.insns[0]).toBe(0x1012);
    expect(() => cls.patchInsns(cls.findMethod('abs')!, () => {})).toThrow(DexError);
  });
  it('prepends code, shifting try ranges and handlers, with an even prefix', () => {
    const d = load(), cls = d.findClass('Lt/A;')!;
    const callee = d.method('Lt/A;', 'plain', 'V', []);
    const odd = (): CodeBuilder => new CodeBuilder({ registers: 2, outs: 1 }).op('invoke-static/range', callee, 1, 1).op('return-void');
    cls.prependCode(cls.findMethod('guarded')!, () => odd());
    const c = cls.codeOf(cls.findMethod('guarded')!)!;
    expect(c.insns.length).toBe(4 + 4);
    expect(c.insns[3]).toBe(0x000e);
    expect(c.tries.map((t) => t.start)).toEqual([4, 6]);
    expect(c.handlers[0]!.catches[0]!.addr).toBe(6);
    expect(c.handlers[1]!.catchAll).toBe(6);
    expect(c.outs).toBe(1);
    expect(c.debugOff).toBe(0);
    // an even prefix is not padded
    cls.prependCode(cls.findMethod('plain')!, (registers) => new CodeBuilder({ registers, outs: 0 }).op('nop').op('nop'));
    expect(cls.codeOf(cls.findMethod('plain')!)!.insns.length).toBe(4);
    expect(validateDex(d.serialize())).toEqual([]);
    expect(() => cls.prependCode(cls.findMethod('abs')!, () => odd())).toThrow('no code');
    expect(() => cls.prependCode(cls.findMethod('plain')!, (registers) => new CodeBuilder({ registers }).label('a').op('nop').label('b').tryCatch({ start: 'a', end: 'b', catchAll: 'a' }))).toThrow('try blocks');
  });
  it('adds static fields once', () => {
    const d = DexFile.parse(buildDex({ classes: [] }));
    const cls = d.addClass({ descriptor: 'Lt/N;' });
    cls.addStaticField('lock', 'Ljava/lang/Object;', ACC.PRIVATE);
    expect(() => cls.addStaticField('lock', 'Ljava/lang/Object;', ACC.PRIVATE)).toThrow('already exists');
    cls.addMethod({ name: 'm', returnType: 'V', params: [], access: ACC.PUBLIC | ACC.STATIC, code: new CodeBuilder({ registers: 1 }).op('return-void') });
    const out = d.serialize();
    expect(validateDex(out)).toEqual([]);
    expect(DexFile.parse(out).classData(DexFile.parse(out).findClass('Lt/N;')!.def).staticFields).toHaveLength(1);
  });
  it('describes callees', () => {
    const d = DexFile.parse(buildDex({ classes: [{ name: 'Lt/B;', super: 'Ljava/lang/Object;', direct: [{ name: 's', ret: 'V', params: [], flags: 9, code: code([0x0071, { m: ['Lt/B;', 'f', 'I', ['J', 'Ljava/lang/String;']] }, 0x0000, 0x000e], 1, 0, 0) }, { name: 'abs', ret: 'V', params: [], flags: 0x108 }] }] }));
    const cls = d.findClass('Lt/B;')!, m = cls.findMethod('s')!;
    const list = insnsOf(cls, m);
    expect(calleeOf(d, list[0]!)).toEqual({ cls: 'Lt/B;', name: 'f', params: ['J', 'Ljava/lang/String;'], ret: 'I' });
    expect(calleeOf(d, list[1]!)).toBeUndefined();
    expect(describeMethod(d, list[0]!.ref!.index).name).toBe('f');
    expect(callsClass(d, cls, m, 'Lt/B;')).toBe(true);
    expect(callsClass(d, cls, m, 'Lt/C;')).toBe(false);
    expect(insnsOf(cls, cls.findMethod('abs')!)).toEqual([]);
    expect(decodeAll(cls.codeOf(m)!.insns)).toHaveLength(2);
  });
});

describe('sign-editor-centred', () => {
  const ET = 'Lcom/apportable/ui/TextView$EditText;';
  const grav: Unit = { m: [ET, 'setGravity', 'V', ['I']] };
  const view = (body: Unit[], withInit = true): ClsSpec => ({
    name: 'Lcom/apportable/ui/TextView;', super: 'Lcom/apportable/ui/View;',
    direct: withInit ? [{ name: 'init', ret: 'V', params: [], flags: 2, code: code(body, 3, 1, 2) }] : [],
  });
  const ctxFor = (body: Unit[], withInit = true) => apkCtx({ 'classes.dex': buildDex({ classes: [view(body, withInit)] }) });
  const real = (v: number): Unit[] => [0x0113, v, 0x206e, grav, 0x0010, 0x000e];

  it('is an opt-in credited patch in the registry', () => {
    expect(defaultRegistry.get('sign-editor-centred')).toBe(signEditorCentred);
    expect(signEditorCentred.optIn).toBe(true);
    expect(signEditorCentred.credits).toBe(JARLPENGUIN_CREDITS);
  });
  it('changes the gravity literal once and keeps the dex valid', () => {
    const c = ctxFor(real(GRAVITY_ORIGINAL));
    expect(signEditorCentred.detect(c)).toBe('notApplied');
    signEditorCentred.apply(c);
    expect(c.logs[0]).toContain('top-centre');
    expect(signEditorCentred.detect(c)).toBe('applied');
    expect(validateDex(getEntry(c.zip, 'classes.dex')!.data)).toEqual([]);
    expect(dexOf(c).findClass('Lcom/apportable/ui/TextView;')!.codeOf(dexOf(c).findClass('Lcom/apportable/ui/TextView;')!.findMethod('init')!)!.insns[1]).toBe(GRAVITY_CENTRED);
    expect(() => signEditorCentred.apply(c)).toThrow(/status: applied/);
  });
  it('is incompatible when the class, method or expected code is missing or different', () => {
    expect(signEditorCentred.detect(apkCtx({}))).toBe('incompatible');
    expect(signEditorCentred.detect(apkCtx({ 'classes.dex': buildDex({ classes: [] }) }))).toBe('incompatible');
    expect(signEditorCentred.detect(ctxFor([], false))).toBe('incompatible');
    expect(signEditorCentred.detect(ctxFor(real(0x35)))).toBe('incompatible');
    expect(() => signEditorCentred.apply(ctxFor(real(0x35)))).toThrow(PatchError);
    expect(signEditorCentred.detect(ctxFor(RET))).toBe('incompatible');
  });
  it('finds the right literal among look-alikes', () => {
    const body: Unit[] = [
      0x0012, // const/4 (not const/16)
      0x0113, 0x44, 0x206e, { m: [ET, 'setPadding', 'V', ['I']] }, 0x0010, // other callee
      0x0113, 0x45, 0x206e, grav, 0x0020, // other register
      0x0113, 0x46, 0x206e, { m: [ET, 'setGravity', 'V', ['Ljava/lang/String;']] }, 0x0010, // other parameter
      0x0113, 0x47, 0x0012, // const/16 not followed by an invoke
      0x0113, 0x33, 0x206e, grav, 0x0010, 0x000e,
    ];
    const c = ctxFor(body);
    expect(signEditorCentred.detect(c)).toBe('notApplied');
    signEditorCentred.apply(c);
    expect(signEditorCentred.detect(c)).toBe('applied');
  });
});

describe('lan-multicast', () => {
  const ACT = 'Lcom/apportable/activity/VerdeActivity;';
  const hook = (name: string, flags = 4): MSpec => ({ name, ret: 'V', params: [], flags, code: code(RET, 2, 1, 0) });
  const act = (names = ['onResume', 'onPause', 'onDestroy'], extra: ClsSpec['virtual'] = []): ClsSpec => ({ name: ACT, super: 'Landroid/app/Activity;', virtual: [...names.map((n) => hook(n)), ...extra] });
  const files = (c: ClsSpec = act()) => ({ 'classes.dex': buildDex({ classes: [c] }), 'classes2.dex': buildDex({ classes: [] }) });

  it('is registered, credited and not opt-in', () => {
    expect(defaultRegistry.get('lan-multicast')).toBe(lanMulticast);
    expect(lanMulticast.credits).toBe(JARLPENGUIN_CREDITS);
    expect(lanMulticast.optIn).toBeUndefined();
  });
  it('adds the permission after the last one, the helper and the three hooks, once', () => {
    const c = apkCtx(files(), manifestTree(['a.b.ONE', 'a.b.TWO']));
    expect(lanMulticast.detect(c)).toBe('notApplied');
    lanMulticast.apply(c);
    expect(c.dirty()).toBe(1);
    expect(c.logs[0]).toContain('onResume, onPause, onDestroy');
    expect(lanMulticast.detect(c)).toBe('applied');
    const perm = findElementsByName(c.manifest, 'uses-permission', MULTICAST_PERMISSION);
    expect(perm).toHaveLength(1);
    expect(getAttr(perm[0]!, 'name', ANDROID_NS, 0x01010003)!.stringValue).toBe(MULTICAST_PERMISSION);
    expect(c.manifest.root.children.indexOf(perm[0]!)).toBe(2);
    const out = getEntry(c.zip, 'classes.dex')!.data;
    expect(validateDex(out)).toEqual([]);
    const d = dexOf(c), cls = d.findClass(ACT)!;
    expect(d.findClass(MULTICAST_CLASS)!.findMethod('acquire', ['Landroid/app/Activity;'], 'V')).toMatchObject({ direct: true, hasCode: true });
    expect(d.findClass(MULTICAST_CLASS)!.findMethod('release', [], 'V')).toBeDefined();
    for (const n of ['onResume', 'onPause', 'onDestroy']) expect(callsClass(d, cls, cls.findMethod(n)!, MULTICAST_CLASS)).toBe(true);
    expect(() => lanMulticast.apply(c)).toThrow(/status: applied/);
  });
  it('inserts the permission first when the manifest has none', () => {
    const c = apkCtx(files(), manifestTree([]));
    lanMulticast.apply(c);
    expect(c.manifest.root.children[0]!.name).toBe('uses-permission');
  });
  it('is incompatible without the activity hooks or a manifest root', () => {
    expect(lanMulticast.detect(apkCtx({}))).toBe('incompatible');
    expect(lanMulticast.detect(apkCtx({ 'classes.dex': buildDex({ classes: [] }) }))).toBe('incompatible');
    expect(lanMulticast.detect(apkCtx(files(act(['onResume', 'onPause']))))).toBe('incompatible');
    expect(lanMulticast.detect(apkCtx(files(act(['onResume', 'onPause'], [{ name: 'onDestroy', ret: 'V', params: [], flags: 0x404 }]))))).toBe('incompatible');
    expect(lanMulticast.detect(apkCtx(files(), manifestTree([], 'other')))).toBe('incompatible');
    expect(() => lanMulticast.apply(apkCtx({}))).toThrow(PatchError);
  });
  it('completes a partial state: permission present, helper present, one hook present', () => {
    const helper: ClsSpec = { name: MULTICAST_CLASS, super: 'Ljava/lang/Object;', direct: [{ name: 'release', ret: 'V', params: [], flags: 9, code: code(RET, 1, 0, 0) }] };
    const hooked: ClsSpec = { name: ACT, super: 'Landroid/app/Activity;', virtual: [
      hook('onResume'), hook('onDestroy'),
      { name: 'onPause', ret: 'V', params: [], flags: 4, code: code([0x0071, { m: [MULTICAST_CLASS, 'release', 'V', []] }, 0x0000, 0x000e], 2, 1, 0) },
    ] };
    const c = apkCtx({ 'classes.dex': buildDex({ classes: [hooked, helper] }) }, manifestTree([MULTICAST_PERMISSION]));
    expect(lanMulticast.detect(c)).toBe('notApplied');
    lanMulticast.apply(c);
    expect(c.dirty()).toBe(0);
    expect(c.logs[0]).toContain('onResume, onDestroy');
    expect(lanMulticast.detect(c)).toBe('applied');
    expect(dexOf(c).classNames().filter((n) => n === MULTICAST_CLASS)).toHaveLength(1);
  });
});

describe('tablet-layout', () => {
  const MGR = 'Lcom/apportable/LibraryManager;', LOADER = 'Lcom/apportable/LibraryLoader;', SPL = 'Lcom/apportable/app/SplashScreen;', STREAM = 'Ljava/io/InputStream;';
  const init: Unit[] = [0x0071, { m: [LOADER, 'init', 'V', []] }, 0x0000];
  const manager = (body: Unit[] = [...init, 0x000e]): ClsSpec => ({ name: MGR, super: 'Ljava/lang/Object;', direct: [{ name: 'initializeLibv', ret: 'V', params: [], flags: 2, code: code(body, 2, 1, 2) }] });
  const splash = (flags = 0xa, hooked = false): ClsSpec => ({ name: SPL, super: 'Ljava/lang/Object;', direct: [{ name: 'getSplashScreen', ret: STREAM, params: [], flags, code: code(hooked ? [0x0071, { m: [TABLET_CLASS, 'splash', STREAM, []] }, 0x0000, 0x000c, 0x0012, 0x0011] : [0x0012, 0x0011], 1, 0, 1) }] });
  const apk = (m: ClsSpec = manager(), s: ClsSpec = splash(), split = true) =>
    apkCtx(split ? { 'classes.dex': buildDex({ classes: [m] }), 'classes2.dex': buildDex({ classes: [s] }) } : { 'classes.dex': buildDex({ classes: [m, s] }) });

  it('is an opt-in credited patch in the registry', () => {
    expect(defaultRegistry.get('tablet-layout')).toBe(tabletLayout);
    expect(tabletLayout.optIn).toBe(true);
    expect(tabletLayout.credits).toBe(JARLPENGUIN_CREDITS);
  });
  it('redirects the native init call and hooks the splash lookup, across dex files, once', () => {
    const c = apk();
    expect(tabletLayout.detect(c)).toBe('notApplied');
    tabletLayout.apply(c);
    expect(c.logs[0]).toContain('experimental');
    expect(tabletLayout.detect(c)).toBe('applied');
    for (const n of ['classes.dex', 'classes2.dex']) expect(validateDex(getEntry(c.zip, n)!.data)).toEqual([]);
    const d1 = dexOf(c), d2 = dexOf(c, 'classes2.dex');
    expect(d1.findClass(TABLET_CLASS)!.findMethod('init', [], 'V')!.direct).toBe(true);
    expect(d1.findClass(TABLET_CLASS)!.findMethod('splash', [], STREAM)).toBeDefined();
    expect(d2.findClass(TABLET_CLASS)).toBeUndefined();
    const m = d1.findClass(MGR)!;
    expect(insnsOf(m, m.findMethod('initializeLibv')!).map((i) => calleeOf(d1, i)?.cls).filter(Boolean)).toEqual([TABLET_CLASS]);
    expect(() => tabletLayout.apply(c)).toThrow(/status: applied/);
  });
  it('works with both classes in one dex', () => {
    const c = apk(manager(), splash(), false);
    tabletLayout.apply(c);
    expect(tabletLayout.detect(c)).toBe('applied');
  });
  it('is incompatible when the expected code is not found', () => {
    expect(tabletLayout.detect(apkCtx({}))).toBe('incompatible');
    expect(tabletLayout.detect(apkCtx({ 'classes.dex': buildDex({ classes: [manager()] }) }))).toBe('incompatible');
    expect(tabletLayout.detect(apkCtx({ 'classes.dex': buildDex({ classes: [splash()] }) }))).toBe('incompatible');
    expect(tabletLayout.detect(apk(manager(RET), splash()))).toBe('incompatible');
    expect(tabletLayout.detect(apk(manager([...init, ...init, 0x000e]), splash()))).toBe('incompatible');
    expect(tabletLayout.detect(apk(manager(), splash(0x2)))).toBe('incompatible');
    expect(() => tabletLayout.apply(apkCtx({}))).toThrow(PatchError);
  });
  it('ignores look-alike calls', () => {
    const decoys: Unit[] = [
      0x0071, { m: ['Lx/Other;', 'init', 'V', []] }, 0x0000,
      0x0071, { m: [LOADER, 'debugWait', 'V', []] }, 0x0000,
      0x0071, { m: [LOADER, 'init', 'V', ['I']] }, 0x0000,
      0x0071, { m: [LOADER, 'init', 'I', []] }, 0x0000,
      0x106e, { m: [LOADER, 'init', 'V', []] }, 0x0000,
      ...init, 0x000e,
    ];
    const c = apk(manager(decoys));
    tabletLayout.apply(c);
    expect(tabletLayout.detect(c)).toBe('applied');
    const d = dexOf(c), m = d.findClass(MGR)!;
    expect(insnsOf(m, m.findMethod('initializeLibv')!).filter((i) => calleeOf(d, i)?.cls === LOADER && calleeOf(d, i)?.name === 'init')).toHaveLength(3);
  });
  it('completes a partial state (init already redirected, splash not)', () => {
    const hookedInit = manager([0x0071, { m: [TABLET_CLASS, 'init', 'V', []] }, 0x0000, 0x000e]);
    const helper: ClsSpec = { name: TABLET_CLASS, super: 'Ljava/lang/Object;', direct: [{ name: 'init', ret: 'V', params: [], flags: 9, code: code(RET, 1, 0, 0) }] };
    const c = apkCtx({ 'classes.dex': buildDex({ classes: [hookedInit, splash(), helper] }) });
    expect(tabletLayout.detect(c)).toBe('notApplied');
    tabletLayout.apply(c);
    expect(tabletLayout.detect(c)).toBe('applied');
    // the other way round: splash hooked, init not
    const c2 = apkCtx({ 'classes.dex': buildDex({ classes: [manager(), splash(0xa, true), helper] }) });
    expect(tabletLayout.detect(c2)).toBe('notApplied');
    tabletLayout.apply(c2);
    expect(tabletLayout.detect(c2)).toBe('applied');
  });
});
