import { describe, it, expect } from 'vitest';
import { DexFile, validateDex } from '../../src/dex';
import { calleeOf, insnsOf } from '../../src/patches/dex-support';
import {
  IMMERSIVE_CLASS, IMMERSIVE_MIN_API, LOOP_GUARD_CLASS, MULTICAST_CLASS, PatchError, defaultRegistry, fixConfigChangeCrash, immersiveFullscreen, lanMulticast,
  type Patch, type PatchContext,
} from '../../src';
import { parseAxml } from '../../src/axml';
import { getEntry, setEntry, type ZipArchive } from '../../src/zip';
import { build } from '../axml-builder';
import { buildDex, type ClsSpec, type MSpec, type Unit } from './fixture';

const ACT = 'Lcom/apportable/activity/VerdeActivity;';
const BUNDLE = 'Landroid/os/Bundle;', CONFIG = 'Landroid/content/res/Configuration;';
const RET: Unit[] = [0x000e];

function apkCtx(files: Record<string, Uint8Array>): PatchContext & { logs: string[] } {
  const zip: ZipArchive = { entries: [] };
  for (const [name, data] of Object.entries(files)) setEntry(zip, { name, data });
  const logs: string[] = [];
  const manifest = parseAxml(build({ name: 'manifest', attrs: [{ name: 'package', str: 'com.noodlecake.blockheads' }], children: [{ name: 'application' }] }));
  return { zip, manifest, info: { packageName: 'com.noodlecake.blockheads', sha256: '' }, markManifestDirty() {}, log: (m) => logs.push(m), logs };
}

const meth = (name: string, params: string[], regs: number, ins: number, insns: Unit[] = RET, flags = 1): MSpec =>
  ({ name, ret: 'V', params, flags, code: { regs, ins, outs: 0, insns } });
const hideSystemUI = (regs = 3, insns?: Unit[]): MSpec => meth('hideSystemUI', [], regs, 1, insns, 2);
const onConfig = (): MSpec => meth('onConfigurationChanged', [CONFIG], 4, 2);
const activity = (direct: MSpec[] = [hideSystemUI()], virtual: MSpec[] = [onConfig()]): ClsSpec =>
  ({ name: ACT, super: 'Landroid/app/Activity;', direct, virtual });
const helperStub: ClsSpec = { name: IMMERSIVE_CLASS, super: 'Ljava/lang/Object;', direct: [{ name: 'hide', ret: 'Z', params: ['Landroid/app/Activity;'], flags: 9, code: { regs: 2, ins: 1, outs: 0, insns: [0x0012, 0x000f] } }] };
const HIDE_CALL: Unit[] = [0x0071, { m: [IMMERSIVE_CLASS, 'hide', 'Z', ['Landroid/app/Activity;']] }, 0x0000];
const dexOf = (ctx: PatchContext, name = 'classes.dex'): DexFile => DexFile.parse(getEntry(ctx.zip, name)!.data);
const calls = (d: DexFile, cls: string, name: string): string[] => {
  const c = d.findClass(cls)!;
  return insnsOf(c, c.findMethod(name)!).map((i) => calleeOf(d, i)).filter(Boolean).map((x) => `${x!.cls.split('/').pop()!.slice(0, -1)}.${x!.name}`);
};

describe('immersive-fullscreen', () => {
  it('is registered and recommended (not opt-in)', () => {
    expect(defaultRegistry.get('immersive-fullscreen')).toBe(immersiveFullscreen);
    expect(immersiveFullscreen.optIn).toBeUndefined();
    expect(immersiveFullscreen.nameKey).toBe('patch.immersive-fullscreen.name');
    expect(IMMERSIVE_MIN_API).toBe(30);
  });

  it('adds the helper next to the activity and hooks hideSystemUI and onConfigurationChanged, once', () => {
    const c = apkCtx({ 'classes.dex': buildDex({ classes: [] }), 'classes2.dex': buildDex({ classes: [activity()] }) });
    expect(immersiveFullscreen.detect(c)).toBe('notApplied');
    immersiveFullscreen.apply(c);
    expect(c.logs[0]).toBe('immersive-fullscreen: VerdeActivity hooks (hideSystemUI, onConfigurationChanged)');
    expect(immersiveFullscreen.detect(c)).toBe('applied');
    expect(() => immersiveFullscreen.apply(c)).toThrow(/status: applied/);
    for (const n of ['classes.dex', 'classes2.dex']) expect(validateDex(getEntry(c.zip, n)!.data)).toEqual([]);
    expect(dexOf(c).findClass(IMMERSIVE_CLASS)).toBeUndefined();
    const d = dexOf(c, 'classes2.dex');
    const h = d.findClass(IMMERSIVE_CLASS)!;
    expect(h.interfaces).toEqual(['Ljava/lang/Runnable;']);
    expect(h.findMethod('<init>', [], 'V')).toMatchObject({ direct: true, hasCode: true });
    expect(h.findMethod('hide', ['Landroid/app/Activity;'], 'Z')).toMatchObject({ direct: true, hasCode: true });
    expect(h.findMethod('run', [], 'V')).toMatchObject({ direct: false, hasCode: true });

    // hide(Activity): API 30 check (else false: the game's flags apply), then posts a new Immersive to the decor view
    const hide = h.findMethod('hide')!;
    const ops = insnsOf(h, hide);
    expect(ops.slice(0, 3).map((i) => i.name)).toEqual(['sget', 'const/16', 'if-lt']);
    expect(ops[1]!.operands[1]).toBe(IMMERSIVE_MIN_API);
    expect(calls(d, IMMERSIVE_CLASS, 'hide')).toEqual(['Activity.getWindow', 'Window.getDecorView', 'Immersive.<init>', 'View.post']);
    expect(h.codeOf(hide)!.tries).toHaveLength(1);
    // run(): multi-window shows the bars, otherwise hide them with swipe-for-transient-bars behaviour
    expect(calls(d, IMMERSIVE_CLASS, 'run')).toEqual([
      'Activity.isInMultiWindowMode', 'Activity.getWindow', 'Window.getInsetsController', 'WindowInsets$Type.systemBars',
      'WindowInsetsController.setSystemBarsBehavior', 'WindowInsetsController.hide', 'WindowInsetsController.show',
    ]);
    expect(h.codeOf(h.findMethod('run')!)!.tries).toHaveLength(1);

    // hideSystemUI returns early when the helper handled it; onConfigurationChanged only re-applies
    expect(calls(d, ACT, 'onConfigurationChanged')).toEqual(['Immersive.hide']);
    const act = d.findClass(ACT)!;
    expect(insnsOf(act, act.findMethod('hideSystemUI')!).map((i) => i.name)).toEqual(['invoke-static/range', 'move-result', 'if-eqz', 'return-void', 'nop', 'return-void']);
  });

  it('completes partial states without adding a second helper', () => {
    const c = apkCtx({ 'classes.dex': buildDex({ classes: [activity([hideSystemUI(3, [...HIDE_CALL, ...RET])]), helperStub] }) });
    expect(immersiveFullscreen.detect(c)).toBe('notApplied');
    immersiveFullscreen.apply(c);
    expect(c.logs[0]).toBe('immersive-fullscreen: VerdeActivity hooks (onConfigurationChanged)');
    expect(immersiveFullscreen.detect(c)).toBe('applied');
    const d = dexOf(c);
    expect(d.classNames().filter((n) => n === IMMERSIVE_CLASS)).toHaveLength(1);
    expect(calls(d, ACT, 'hideSystemUI')).toEqual(['Immersive.hide']);
  });

  it('is incompatible without the activity, a hooked method or a scratch register in hideSystemUI', () => {
    const inc = (classes: ClsSpec[]): string => immersiveFullscreen.detect(apkCtx({ 'classes.dex': buildDex({ classes }) }));
    expect(immersiveFullscreen.detect(apkCtx({}))).toBe('incompatible');
    expect(inc([])).toBe('incompatible');
    expect(inc([activity([])])).toBe('incompatible');
    expect(inc([activity(undefined, [])])).toBe('incompatible');
    expect(inc([activity([hideSystemUI(1)])])).toBe('incompatible');
    const nativeConfig: MSpec = { name: 'onConfigurationChanged', ret: 'V', params: [CONFIG], flags: 0x101 };
    expect(inc([activity(undefined, [nativeConfig])])).toBe('incompatible');
    expect(() => immersiveFullscreen.apply(apkCtx({}))).toThrow(PatchError);
  });

  it('composes with the other VerdeActivity hooks in any order', () => {
    const orders: Patch[][] = [[fixConfigChangeCrash, lanMulticast, immersiveFullscreen], [immersiveFullscreen, lanMulticast, fixConfigChangeCrash]];
    const lifecycle = [meth('onCreate', [BUNDLE], 5, 2, RET, 4), onConfig(), meth('onResume', [], 3, 1), meth('onPause', [], 1, 1), meth('onDestroy', [], 1, 1)];
    for (const order of orders) {
      const c = apkCtx({ 'classes.dex': buildDex({ classes: [activity(undefined, lifecycle)] }) });
      for (const p of order) p.apply(c);
      for (const p of order) expect(p.detect(c), p.id).toBe('applied');
      expect(validateDex(getEntry(c.zip, 'classes.dex')!.data)).toEqual([]);
      const d = dexOf(c);
      expect([LOOP_GUARD_CLASS, MULTICAST_CLASS, IMMERSIVE_CLASS].every((n) => d.findClass(n))).toBe(true);
      expect(calls(d, ACT, 'onCreate')).toEqual(['LoopGuard.install']);
      expect(calls(d, ACT, 'onResume')).toEqual(['MulticastHold.acquire']);
      expect(calls(d, ACT, 'onConfigurationChanged')).toEqual(['Immersive.hide']);
    }
  });
});
