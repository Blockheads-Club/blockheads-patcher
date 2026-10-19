import { describe, it, expect } from 'vitest';
import { DexFile, validateDex } from '../../src/dex';
import { calleeOf, insnsOf } from '../../src/patches/dex-support';
import { LOOP_GUARD_CLASS, PatchError, WRONG_THREAD_EXCEPTION, defaultRegistry, fixConfigChangeCrash, type PatchContext } from '../../src';
import { parseAxml } from '../../src/axml';
import { getEntry, setEntry, type ZipArchive } from '../../src/zip';
import { build } from '../axml-builder';
import { buildDex, type ClsSpec, type MSpec, type Unit } from './fixture';

const ACT = 'Lcom/apportable/activity/VerdeActivity;';
const BUNDLE = 'Landroid/os/Bundle;';
const RET: Unit[] = [0x000e];

function apkCtx(files: Record<string, Uint8Array>): PatchContext & { logs: string[] } {
  const zip: ZipArchive = { entries: [] };
  for (const [name, data] of Object.entries(files)) setEntry(zip, { name, data });
  const logs: string[] = [];
  const manifest = parseAxml(build({ name: 'manifest', attrs: [{ name: 'package', str: 'com.noodlecake.blockheads' }], children: [{ name: 'application' }] }));
  return { zip, manifest, info: { packageName: 'com.noodlecake.blockheads', sha256: '' }, markManifestDirty() {}, log: (m) => logs.push(m), logs };
}

const onCreate = (insns: Unit[] = RET, over: Partial<MSpec> = {}): MSpec =>
  ({ name: 'onCreate', ret: 'V', params: [BUNDLE], flags: 4, code: { regs: 5, ins: 2, outs: 0, insns }, ...over });
const activity = (methods: MSpec[] = [onCreate()]): ClsSpec => ({ name: ACT, super: 'Landroid/app/Activity;', virtual: methods });
const guardStub: ClsSpec = { name: LOOP_GUARD_CLASS, super: 'Ljava/lang/Object;', direct: [{ name: 'install', ret: 'V', params: [], flags: 9, code: { regs: 0, ins: 0, outs: 0, insns: RET } }] };
const INSTALL_CALL: Unit[] = [0x0071, { m: [LOOP_GUARD_CLASS, 'install', 'V', []] }, 0x0000];
const dexOf = (ctx: PatchContext, name: string): DexFile => DexFile.parse(getEntry(ctx.zip, name)!.data);

describe('fix-config-change-crash', () => {
  it('is registered and recommended (not opt-in)', () => {
    expect(defaultRegistry.get('fix-config-change-crash')).toBe(fixConfigChangeCrash);
    expect(fixConfigChangeCrash.optIn).toBeUndefined();
    expect(fixConfigChangeCrash.nameKey).toBe('patch.fix-config-change-crash.name');
  });

  it('adds LoopGuard to the dex holding the activity and hooks the start of onCreate, once', () => {
    const c = apkCtx({ 'classes.dex': buildDex({ classes: [] }), 'classes2.dex': buildDex({ classes: [activity()] }) });
    expect(fixConfigChangeCrash.detect(c)).toBe('notApplied');
    fixConfigChangeCrash.apply(c);
    expect(c.logs[0]).toContain('onCreate');
    expect(fixConfigChangeCrash.detect(c)).toBe('applied');
    expect(() => fixConfigChangeCrash.apply(c)).toThrow(/status: applied/);
    for (const n of ['classes.dex', 'classes2.dex']) expect(validateDex(getEntry(c.zip, n)!.data)).toEqual([]);
    expect(dexOf(c, 'classes.dex').findClass(LOOP_GUARD_CLASS)).toBeUndefined();
    const d = dexOf(c, 'classes2.dex');
    const guard = d.findClass(LOOP_GUARD_CLASS)!;
    expect(guard.interfaces).toEqual(['Ljava/lang/Runnable;']);
    expect(guard.findMethod('<init>', [], 'V')).toMatchObject({ direct: true, hasCode: true });
    expect(guard.findMethod('install', [], 'V')).toMatchObject({ direct: true, hasCode: true });
    const run = guard.findMethod('run', [], 'V')!;
    expect(run.direct).toBe(false);

    // run(): Looper.loop() guarded by a Throwable handler that compares the class name and rethrows anything else
    const code = guard.codeOf(run)!;
    expect(code.tries).toEqual([{ start: 0, count: 3, handler: 0 }]);
    expect(code.handlers[0]!.catches.map((x) => [d.typeName(x.type), x.addr])).toEqual([['Ljava/lang/Throwable;', 4]]);
    const ops = insnsOf(guard, run);
    expect(ops.map((i) => i.name)).toEqual([
      'invoke-static', 'return-void', 'move-exception', 'invoke-virtual', 'move-result-object', 'invoke-virtual', 'move-result-object',
      'const-string', 'invoke-virtual', 'move-result', 'if-eqz', 'const-string', 'const-string', 'invoke-static', 'goto', 'throw',
    ]);
    expect(calleeOf(d, ops[0]!)).toMatchObject({ cls: 'Landroid/os/Looper;', name: 'loop' });
    expect(d.text(ops[7]!.ref!.index)).toBe(WRONG_THREAD_EXCEPTION);
    expect(calleeOf(d, ops[13]!)).toMatchObject({ cls: 'Landroid/util/Log;', name: 'w' });

    // install(): posts a new LoopGuard to the main looper
    const inst = guard.findMethod('install', [], 'V')!;
    const callees = insnsOf(guard, inst).map((i) => calleeOf(d, i)).filter(Boolean).map((x) => `${x!.cls}.${x!.name}`);
    expect(callees).toEqual(['Landroid/os/Looper;.getMainLooper', 'Landroid/os/Handler;.<init>', `${LOOP_GUARD_CLASS}.<init>`, 'Landroid/os/Handler;.post']);

    // onCreate starts with the install call, then the original body (after the even-length padding)
    const act = d.findClass(ACT)!, oc = act.findMethod('onCreate', [BUNDLE], 'V')!;
    const body = insnsOf(act, oc);
    expect(calleeOf(d, body[0]!)).toMatchObject({ cls: LOOP_GUARD_CLASS, name: 'install' });
    expect(body.map((i) => i.name)).toEqual(['invoke-static', 'nop', 'return-void']);
  });

  it('completes partial states without adding a second class', () => {
    const classOnly = apkCtx({ 'classes.dex': buildDex({ classes: [activity(), guardStub] }) });
    expect(fixConfigChangeCrash.detect(classOnly)).toBe('notApplied');
    fixConfigChangeCrash.apply(classOnly);
    expect(fixConfigChangeCrash.detect(classOnly)).toBe('applied');
    expect(dexOf(classOnly, 'classes.dex').classNames().filter((n) => n === LOOP_GUARD_CLASS)).toHaveLength(1);

    const hookOnly = apkCtx({ 'classes.dex': buildDex({ classes: [activity([onCreate([...INSTALL_CALL, ...RET])])] }) });
    expect(fixConfigChangeCrash.detect(hookOnly)).toBe('notApplied');
    fixConfigChangeCrash.apply(hookOnly);
    expect(fixConfigChangeCrash.detect(hookOnly)).toBe('applied');
    const d = dexOf(hookOnly, 'classes.dex'), act = d.findClass(ACT)!;
    expect(insnsOf(act, act.findMethod('onCreate')!).filter((i) => calleeOf(d, i)?.cls === LOOP_GUARD_CLASS)).toHaveLength(1);
    expect(d.findClass(LOOP_GUARD_CLASS)!.findMethod('run')).toBeDefined();
  });

  it('is incompatible without the activity or a usable onCreate(Bundle)', () => {
    expect(fixConfigChangeCrash.detect(apkCtx({}))).toBe('incompatible');
    expect(fixConfigChangeCrash.detect(apkCtx({ 'classes.dex': buildDex({ classes: [] }) }))).toBe('incompatible');
    expect(fixConfigChangeCrash.detect(apkCtx({ 'classes.dex': buildDex({ classes: [activity([])] }) }))).toBe('incompatible');
    expect(fixConfigChangeCrash.detect(apkCtx({ 'classes.dex': buildDex({ classes: [activity([onCreate(RET, { params: [] })])] }) }))).toBe('incompatible');
    const nativeOnCreate = onCreate(RET, { flags: 0x104 });
    delete nativeOnCreate.code;
    expect(fixConfigChangeCrash.detect(apkCtx({ 'classes.dex': buildDex({ classes: [activity([nativeOnCreate])] }) }))).toBe('incompatible');
    expect(() => fixConfigChangeCrash.apply(apkCtx({}))).toThrow(PatchError);
  });
});
