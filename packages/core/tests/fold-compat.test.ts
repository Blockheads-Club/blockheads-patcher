import { describe, it, expect } from 'vitest';
import { DexFile, validateDex } from '../src/dex';
import { calleeOf, insnsOf } from '../src/patches/dex-support';
import {
  ANDROID_NS, MAX_ASPECT_META, PatchError, RESTART_ACTIVITY_CLASS, RESTART_ACTIVITY_NAME, RESTART_MIN_DP, SCREEN_RESTART_CLASS,
  defaultRegistry, findElements, getAttr, parseAxml, removeMaxAspect, restartOnResize, type PatchContext,
} from '../src';
import { getEntry, setEntry, type ZipArchive } from '../src/zip';
import { build, type BEl } from './axml-builder';
import { buildDex, type ClsSpec, type MSpec, type Unit } from './dex/fixture';

const NAME = { name: 'name', res: 0x01010003 };
const ACT = 'Lcom/apportable/activity/VerdeActivity;';
const BUNDLE = 'Landroid/os/Bundle;', CONFIG = 'Landroid/content/res/Configuration;';
const RET: Unit[] = [0x000e];

function ctxOf(app: BEl | null, files: Record<string, Uint8Array> = {}): PatchContext & { logs: string[]; dirty: () => number; doc: ReturnType<typeof parseAxml> } {
  const zip: ZipArchive = { entries: [] };
  for (const [name, data] of Object.entries(files)) setEntry(zip, { name, data });
  const logs: string[] = [];
  let dirty = 0;
  const doc = parseAxml(build({ name: 'manifest', attrs: [{ name: 'package', str: 'com.noodlecake.blockheads' }], children: app ? [app] : [] }));
  return { zip, manifest: doc, doc, info: { packageName: 'com.noodlecake.blockheads', sha256: '' }, markManifestDirty() { dirty++; }, log: (m) => logs.push(m), logs, dirty: () => dirty };
}
const meta = (name: string): BEl => ({ name: 'meta-data', attrs: [{ ...NAME, str: name }, { name: 'value', res: 0x01010024, type: 0x04, data: 0x40066666 }] });

describe('remove-max-aspect', () => {
  it('is registered and recommended', () => {
    expect(defaultRegistry.get('remove-max-aspect')).toBe(removeMaxAspect);
    expect(removeMaxAspect.optIn).toBeUndefined();
    expect(removeMaxAspect.nameKey).toBe('patch.remove-max-aspect.name');
  });
  it('removes only the max_aspect meta-data, once', () => {
    const c = ctxOf({ name: 'application', children: [meta('android.app.lib_name'), meta(MAX_ASPECT_META)] });
    expect(removeMaxAspect.detect(c)).toBe('notApplied');
    removeMaxAspect.apply(c);
    expect(c.dirty()).toBe(1);
    expect(c.logs[0]).toContain('android.max_aspect');
    expect(removeMaxAspect.detect(c)).toBe('applied');
    const names = findElements(c.doc, (e) => e.name === 'meta-data').map((e) => getAttr(e, 'name', ANDROID_NS, 0x01010003)?.stringValue);
    expect(names).toEqual(['android.app.lib_name']);
    expect(() => removeMaxAspect.apply(c)).toThrow(/status: applied/);
  });
  it('is incompatible without an application element', () => {
    const c = ctxOf(null);
    expect(removeMaxAspect.detect(c)).toBe('incompatible');
    expect(() => removeMaxAspect.apply(c)).toThrow(PatchError);
  });
});

const meth = (name: string, params: string[], regs: number, ins: number, flags = 1): MSpec => ({ name, ret: 'V', params, flags, code: { regs, ins, outs: 0, insns: RET } });
const activity = (virtual: MSpec[] = [meth('onConfigurationChanged', [CONFIG], 4, 2)], direct: MSpec[] = [meth('onCreate', [BUNDLE], 5, 2, 4)]): ClsSpec =>
  ({ name: ACT, super: 'Landroid/app/Activity;', direct, virtual });
const app = (): BEl => ({ name: 'application', children: [{ name: 'activity', attrs: [{ ...NAME, str: 'com.apportable.activity.VerdeActivity' }] }] });
const dexOf = (c: PatchContext): DexFile => DexFile.parse(getEntry(c.zip, 'classes.dex')!.data);
const calls = (d: DexFile, cls: string, name: string): string[] => {
  const k = d.findClass(cls)!;
  return insnsOf(k, k.findMethod(name)!).map((i) => calleeOf(d, i)).filter(Boolean).map((x) => `${x!.cls.split('/').pop()!.slice(0, -1)}.${x!.name}`);
};
const attrOf = (c: ReturnType<typeof ctxOf>, n: string, id: number) =>
  getAttr(findElements(c.doc, (e) => e.name === 'activity' && getAttr(e, 'name', ANDROID_NS, 0x01010003)?.stringValue === RESTART_ACTIVITY_NAME)[0]!, n, ANDROID_NS, id);

describe('restart-on-resize', () => {
  it('is registered and opt-in', () => {
    expect(defaultRegistry.get('restart-on-resize')).toBe(restartOnResize);
    expect(restartOnResize.optIn).toBe(true);
    expect(RESTART_MIN_DP).toBe(600);
  });

  it('adds both classes, the manifest entry and the two hooks, once', () => {
    const c = ctxOf(app(), { 'classes.dex': buildDex({ classes: [activity()] }) });
    expect(restartOnResize.detect(c)).toBe('notApplied');
    restartOnResize.apply(c);
    expect(c.logs[0]).toContain('RestartActivity');
    expect(c.dirty()).toBe(1);
    expect(restartOnResize.detect(c)).toBe('applied');
    expect(() => restartOnResize.apply(c)).toThrow(/status: applied/);
    expect(validateDex(getEntry(c.zip, 'classes.dex')!.data)).toEqual([]);
    const d = dexOf(c);
    const h = d.findClass(SCREEN_RESTART_CLASS)!;
    expect(h.interfaces).toEqual(['Ljava/lang/Runnable;']);
    expect(calls(d, SCREEN_RESTART_CLASS, 'size')).toEqual([
      'Activity.isInMultiWindowMode', 'DisplayMetrics.<init>', 'Activity.getWindowManager', 'WindowManager.getDefaultDisplay', 'Display.getRealMetrics', 'Math.min',
    ]);
    expect(insnsOf(h, h.findMethod('size')!).find((i) => i.name === 'const/16' && i.operands[1] === RESTART_MIN_DP)).toBeDefined();
    expect(h.codeOf(h.findMethod('size')!)!.tries).toHaveLength(1);
    expect(calls(d, SCREEN_RESTART_CLASS, 'start')).toEqual(['ScreenRestart.size']);
    expect(calls(d, SCREEN_RESTART_CLASS, 'changed')).toEqual(['ScreenRestart.size', 'ScreenRestart.restart']);
    expect(calls(d, SCREEN_RESTART_CLASS, 'restart')).toEqual([
      'Intent.<init>', 'Activity.startActivity', 'Activity.finish', 'Looper.getMainLooper', 'Handler.<init>', 'ScreenRestart.<init>', 'Handler.postDelayed',
    ]);
    expect(calls(d, SCREEN_RESTART_CLASS, 'run')).toEqual(['Process.myPid', 'Process.killProcess']);
    const a = d.findClass(RESTART_ACTIVITY_CLASS)!;
    expect(a.interfaces).toEqual(['Ljava/lang/Runnable;']);
    expect(d.classNames()).toContain(RESTART_ACTIVITY_CLASS);
    expect(calls(d, RESTART_ACTIVITY_CLASS, 'run')).toEqual([
      'Activity.getPackageManager', 'Activity.getPackageName', 'PackageManager.getLaunchIntentForPackage', 'Intent.addFlags', 'Activity.startActivity',
      'Activity.finish', 'Process.myPid', 'Process.killProcess',
    ]);
    expect(calls(d, ACT, 'onCreate')).toEqual(['ScreenRestart.start']);
    expect(calls(d, ACT, 'onConfigurationChanged')).toEqual(['ScreenRestart.changed']);
    expect(attrOf(c, 'process', 0x01010011)!.stringValue).toBe(':restart');
    expect(attrOf(c, 'exported', 0x01010010)!.data).toBe(0);
    expect(attrOf(c, 'excludeFromRecents', 0x01010017)!.data).toBe(0xffffffff);
    expect(attrOf(c, 'theme', 0x01010000)!.data).toBe(0x01030010);
  });

  it('completes a partial state (hook present, manifest entry missing) without a second helper', () => {
    const c = ctxOf(app(), { 'classes.dex': buildDex({ classes: [activity()] }) });
    restartOnResize.apply(c);
    const only = findElements(c.doc, (e) => e.name === 'application')[0]!;
    only.children.splice(only.children.findIndex((e) => getAttr(e, 'name', ANDROID_NS, 0x01010003)?.stringValue === RESTART_ACTIVITY_NAME), 1);
    expect(restartOnResize.detect(c)).toBe('notApplied');
    restartOnResize.apply(c);
    expect(restartOnResize.detect(c)).toBe('applied');
    expect(dexOf(c).classNames().filter((n) => n === SCREEN_RESTART_CLASS)).toHaveLength(1);
  });

  it('is incompatible without the activity, a hook target or an application element', () => {
    const inc = (classes: ClsSpec[], a: BEl | null = app()): string => restartOnResize.detect(ctxOf(a, { 'classes.dex': buildDex({ classes }) }));
    expect(restartOnResize.detect(ctxOf(app()))).toBe('incompatible');
    expect(inc([])).toBe('incompatible');
    expect(inc([activity(undefined, [])])).toBe('incompatible');
    expect(inc([activity([])])).toBe('incompatible');
    const nativeConfig: MSpec = { name: 'onConfigurationChanged', ret: 'V', params: [CONFIG], flags: 0x101 };
    expect(inc([activity([nativeConfig])])).toBe('incompatible');
    expect(inc([activity()], null)).toBe('incompatible');
    expect(() => restartOnResize.apply(ctxOf(app()))).toThrow(PatchError);
  });
});
