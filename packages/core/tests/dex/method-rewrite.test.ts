import { describe, it, expect } from 'vitest';
import { CodeBuilder, DexFile, validateDex } from '../../src/dex';
import {
  AUDIO_MANAGER_CLASS, GL_SURFACE_VIEW_CLASS, LIFECYCLE_CLASS, WAKE_METHOD, SURFACE_WAIT_MS, JARLPENGUIN_CREDITS, PatchError, defaultRegistry,
  fixAudioFocusStall, fixAudioFocusStallSpec, fixBackgroundWakeup, fixBackgroundWakeupSpec, fixSurfaceDestroyFreeze, fixSurfaceDestroyFreezeSpec,
  makeMethodRewritePatch, musicWithOtherApps, musicWithOtherAppsSpec, type MethodRewriteSpec, type Patch, type PatchContext,
} from '../../src';
import { getEntry, setEntry, type ZipArchive } from '../../src/zip';
import { buildDex, type ClsSpec, type MSpec } from './fixture';

const stub = (name: string, ret: string, params: string[] = [], flags = 1): MSpec => ({
  name, ret, params, flags, code: { regs: 9, ins: flags & 8 ? params.length : params.length + 1, outs: 0, insns: ret === 'V' ? [0x000e] : [0x1012, 0x000f] },
});
const cls = (name: string, ...methods: MSpec[]): ClsSpec => ({ name, super: 'Ljava/lang/Object;', source: 'X.java', virtual: methods, direct: [] });

const ctxOf = (files: Record<string, Uint8Array>): PatchContext & { zip: ZipArchive; logs: string[] } => {
  const zip: ZipArchive = { entries: [] };
  for (const [name, data] of Object.entries(files)) setEntry(zip, { name, data });
  const logs: string[] = [];
  return { zip, manifest: null as never, info: { packageName: 'com.noodlecake.blockheads', sha256: '' }, markManifestDirty() {}, log: (m) => logs.push(m), logs };
};
/** A dex whose stub method for `spec` carries the shipped body, as assembled by the spec itself. */
function shipped(spec: MethodRewriteSpec, owner: ClsSpec, withOriginal = true): Uint8Array {
  const d = DexFile.parse(buildDex({ classes: [owner] }));
  if (withOriginal) {
    const c = d.findClass(spec.cls)!;
    c.replaceBody(c.findMethod(spec.method.name, spec.method.params, spec.method.returnType)!, spec.original(d));
  }
  return d.serialize();
}
const dexOf = (c: PatchContext, name = 'classes.dex'): DexFile => DexFile.parse(getEntry(c.zip, name)!.data);

const cases: [Patch, MethodRewriteSpec, ClsSpec][] = [
  [musicWithOtherApps, musicWithOtherAppsSpec, cls(AUDIO_MANAGER_CLASS, stub('isMusicActive', 'Z'))],
  [fixAudioFocusStall, fixAudioFocusStallSpec, { ...cls(AUDIO_MANAGER_CLASS), direct: [stub('waitOnConnection', 'V', [], 2)] }],
  [fixSurfaceDestroyFreeze, fixSurfaceDestroyFreezeSpec, cls(GL_SURFACE_VIEW_CLASS, stub('surfaceDestroyed', 'V'))],
  [fixBackgroundWakeup, fixBackgroundWakeupSpec, { ...cls(LIFECYCLE_CLASS), direct: [stub('testInBackground', 'V', [], 10)] }],
];

describe.each(cases)('method rewrite: %# ', (patch, spec, owner) => {
  it('is registered with credits and the right default', () => {
    expect(defaultRegistry.get(patch.id)).toBe(patch);
    expect(patch.credits).toBe(JARLPENGUIN_CREDITS);
    expect(patch.appliesTo.packageName).toBe('com.noodlecake.blockheads');
    expect(!!patch.optIn).toBe(patch === fixBackgroundWakeup);
  });
  it('is incompatible without dex, without the class or with a different body', () => {
    expect(patch.detect(ctxOf({}))).toBe('incompatible');
    expect(() => patch.apply(ctxOf({}))).toThrow(PatchError);
    expect(patch.detect(ctxOf({ 'classes.dex': buildDex({ classes: [cls('Lx/Other;', stub('f', 'V'))] }) }))).toBe('incompatible');
    // stub body is not the shipped code
    expect(patch.detect(ctxOf({ 'classes.dex': shipped(spec, owner, false) }))).toBe('incompatible');
  });
  it('applies to the shipped body once, validates and logs', () => {
    const c = ctxOf({ 'classes.dex': shipped(spec, owner), 'classes2.dex': buildDex({ classes: [cls('Lx/Y;', stub('f', 'V'))] }) });
    expect(patch.detect(c)).toBe('notApplied');
    patch.apply(c);
    expect(c.logs).toEqual([spec.logMessage]);
    expect(patch.detect(c)).toBe('applied');
    expect(validateDex(getEntry(c.zip, 'classes.dex')!.data)).toEqual([]);
    const before = getEntry(c.zip, 'classes.dex')!.data;
    expect(() => patch.apply(c)).toThrow(/status: applied/);
    expect(getEntry(c.zip, 'classes.dex')!.data).toBe(before);
  });
});

describe('patch specifics', () => {
  const apply = (p: Patch, s: MethodRewriteSpec, o: ClsSpec): PatchContext => { const c = ctxOf({ 'classes.dex': shipped(s, o) }); p.apply(c); return c; };
  it('music-with-other-apps returns constant false', () => {
    const c = apply(musicWithOtherApps, musicWithOtherAppsSpec, cases[0]![2]);
    const d = dexOf(c);
    expect(d.findClass(AUDIO_MANAGER_CLASS)!.findMethod('isMusicActive', [], 'Z')).toMatchObject({ hasCode: true });
  });
  it('surface-destroy keeps a short bound', () => {
    expect(SURFACE_WAIT_MS).toBe(250);
    const c = apply(fixSurfaceDestroyFreeze, fixSurfaceDestroyFreezeSpec, cases[2]![2]);
    const d = dexOf(c);
    expect(d.strings.some((_, i) => d.text(i) === 'uptimeMillis')).toBe(true);
  });
  it('background wake-up adds one helper method and completes only from the shipped body', () => {
    const c = apply(fixBackgroundWakeup, fixBackgroundWakeupSpec, cases[3]![2]);
    expect(dexOf(c).findClass(LIFECYCLE_CLASS)!.findMethod(WAKE_METHOD, [], 'V')).toMatchObject({ direct: true, hasCode: true });
  });
  it('maps a failing prepare step (helper already present) to a PatchError', () => {
    const owner: ClsSpec = { ...cases[3]![2], direct: [stub('testInBackground', 'V', [], 10), stub(WAKE_METHOD, 'V', [], 9)] };
    const c = ctxOf({ 'classes.dex': shipped(fixBackgroundWakeupSpec, owner) });
    expect(fixBackgroundWakeup.detect(c)).toBe('notApplied');
    expect(() => fixBackgroundWakeup.apply(c)).toThrow(PatchError);
  });
});

describe('makeMethodRewritePatch', () => {
  const C = 'Lg/Holder;';
  const spec: MethodRewriteSpec = {
    id: 'demo', cls: C, method: { name: 'sum', params: ['J', 'I', 'D'], returnType: 'I' },
    original: () => new CodeBuilder({ registers: 6 }).op('const/4', 0, 1).op('return', 0),
    patched: () => new CodeBuilder({ registers: 6 }).op('const/4', 0, 2).op('return', 0),
    logMessage: 'done',
  };
  const holder: ClsSpec = { name: C, super: 'Ljava/lang/Object;', direct: [stub('sum', 'I', ['J', 'I', 'D'], 9)], virtual: [] };
  it('handles static methods with wide parameters, no credits and no prepare hook', () => {
    const p = makeMethodRewritePatch(spec);
    expect(p.credits).toBeUndefined();
    expect(p.optIn).toBeUndefined();
    const c = ctxOf({ 'classes.dex': shipped(spec, holder) });
    expect(p.detect(c)).toBe('notApplied');
    p.apply(c);
    expect(p.detect(c)).toBe('applied');
    expect(c.logs).toEqual(['done']);
  });
  it('honours optIn and credits and rejects methods without code', () => {
    const p = makeMethodRewritePatch({ ...spec, optIn: true, credits: JARLPENGUIN_CREDITS });
    expect([p.optIn, p.credits]).toEqual([true, JARLPENGUIN_CREDITS]);
    const abstractHolder: ClsSpec = { name: C, flags: 0x401, super: 'Ljava/lang/Object;', direct: [], virtual: [{ name: 'sum', ret: 'I', params: ['J', 'I', 'D'], flags: 0x401 }] };
    expect(p.detect(ctxOf({ 'classes.dex': buildDex({ classes: [abstractHolder] }) }))).toBe('incompatible');
  });
});
