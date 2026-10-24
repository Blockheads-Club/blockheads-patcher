import { describe, it, expect } from 'vitest';
import { DexFile, validateDex } from '../../src/dex';
import { calleeOf, insnsOf } from '../../src/patches/dex-support';
import { PatchError, SURFACE_POLL_MS, SURFACE_WAIT_CLASS, defaultRegistry, fixSurfaceWaitDeadlock, type PatchContext } from '../../src';
import { parseAxml } from '../../src/axml';
import { getEntry, setEntry, type ZipArchive } from '../../src/zip';
import { build } from '../axml-builder';
import { buildDex, type ClsSpec, type Unit } from './fixture';

const GL = 'Lcom/apportable/gl/GLSurfaceView;';
const WAIT: Unit[] = [0x106e, { m: ['Ljava/lang/Object;', 'wait', 'V', []] }, 0x0005];
const RET: Unit[] = [0x000e];
const VIEW = (insns: Unit[]): ClsSpec => ({
  name: GL, super: 'Ljava/lang/Object;',
  virtual: [{ name: 'readySurface', ret: 'V', params: [], flags: 1, code: { regs: 6, ins: 1, outs: 1, insns } }],
});
const helperStub: ClsSpec = {
  name: SURFACE_WAIT_CLASS, super: 'Ljava/lang/Object;',
  direct: [{ name: 'await', ret: 'V', params: ['Ljava/lang/Object;'], flags: 9, code: { regs: 1, ins: 1, outs: 0, insns: RET } }],
};
const AWAIT_CALL: Unit[] = [0x1071, { m: [SURFACE_WAIT_CLASS, 'await', 'V', ['Ljava/lang/Object;']] }, 0x0005];

function ctxOf(files: Record<string, Uint8Array>): PatchContext & { logs: string[] } {
  const zip: ZipArchive = { entries: [] };
  for (const [name, data] of Object.entries(files)) setEntry(zip, { name, data });
  const logs: string[] = [];
  const manifest = parseAxml(build({ name: 'manifest', attrs: [{ name: 'package', str: 'com.noodlecake.blockheads' }], children: [{ name: 'application' }] }));
  return { zip, manifest, info: { packageName: 'com.noodlecake.blockheads', sha256: '' }, markManifestDirty() {}, log: (m) => logs.push(m), logs };
}
const dexOf = (c: PatchContext, n = 'classes.dex'): DexFile => DexFile.parse(getEntry(c.zip, n)!.data);

describe('fix-surface-wait-deadlock', () => {
  it('is registered and recommended (not opt-in)', () => {
    expect(defaultRegistry.get('fix-surface-wait-deadlock')).toBe(fixSurfaceWaitDeadlock);
    expect(fixSurfaceWaitDeadlock.optIn).toBeUndefined();
    expect(fixSurfaceWaitDeadlock.nameKey).toBe('patch.fix-surface-wait-deadlock.name');
    expect(SURFACE_POLL_MS).toBe(150);
  });

  it('is incompatible without a dex, without the class, or unless readySurface has exactly one wait()', () => {
    expect(fixSurfaceWaitDeadlock.detect(ctxOf({}))).toBe('incompatible');
    expect(() => fixSurfaceWaitDeadlock.apply(ctxOf({}))).toThrow(PatchError);
    expect(fixSurfaceWaitDeadlock.detect(ctxOf({ 'classes.dex': buildDex({ classes: [{ name: 'Lx/Y;', super: 'Ljava/lang/Object;' }] }) }))).toBe('incompatible');
    expect(fixSurfaceWaitDeadlock.detect(ctxOf({ 'classes.dex': buildDex({ classes: [VIEW(RET)] }) }))).toBe('incompatible');
    expect(fixSurfaceWaitDeadlock.detect(ctxOf({ 'classes.dex': buildDex({ classes: [VIEW([...WAIT, ...WAIT, ...RET])] }) }))).toBe('incompatible');
    const native: ClsSpec = { name: GL, super: 'Ljava/lang/Object;', virtual: [{ name: 'readySurface', ret: 'V', params: [], flags: 0x101 }] };
    expect(fixSurfaceWaitDeadlock.detect(ctxOf({ 'classes.dex': buildDex({ classes: [native] }) }))).toBe('incompatible');
  });

  it('replaces the wait() with SurfaceWait.await (same size), adds the helper, once', () => {
    const c = ctxOf({ 'classes.dex': buildDex({ classes: [VIEW([...WAIT, ...RET])] }) });
    expect(fixSurfaceWaitDeadlock.detect(c)).toBe('notApplied');
    fixSurfaceWaitDeadlock.apply(c);
    expect(c.logs).toHaveLength(1);
    expect(fixSurfaceWaitDeadlock.detect(c)).toBe('applied');
    expect(validateDex(getEntry(c.zip, 'classes.dex')!.data)).toEqual([]);
    expect(() => fixSurfaceWaitDeadlock.apply(c)).toThrow(/status: applied/);

    const d = dexOf(c);
    const view = d.findClass(GL)!, rs = view.findMethod('readySurface', [], 'V')!;
    const ops = insnsOf(view, rs);
    expect(ops.map((i) => i.name)).toEqual(['invoke-static', 'return-void']);
    expect(calleeOf(d, ops[0]!)).toMatchObject({ cls: SURFACE_WAIT_CLASS, name: 'await', params: ['Ljava/lang/Object;'] });
    expect(ops[0]!.operands).toContain(5);

    // await(): timed wait inside an InterruptedException handler, then a background check that throws
    const helper = d.findClass(SURFACE_WAIT_CLASS)!, aw = helper.findMethod('await', ['Ljava/lang/Object;'], 'V')!;
    expect(aw.direct).toBe(true);
    const code = helper.codeOf(aw)!;
    expect(code.handlers[0]!.catches.map((x) => d.typeName(x.type))).toEqual(['Ljava/lang/InterruptedException;']);
    const callees = insnsOf(helper, aw).map((i) => calleeOf(d, i)).filter(Boolean).map((x) => `${x!.cls}.${x!.name}(${x!.params.join(',')})`);
    expect(callees).toEqual([
      'Ljava/lang/Object;.wait(J)', 'Lcom/apportable/Lifecycle;.isInBackground()', 'Ljava/lang/IllegalStateException;.<init>(Ljava/lang/String;)',
    ]);
    expect(insnsOf(helper, aw).map((i) => i.name)).toContain('throw');
  });

  it('completes partial states without a second helper or a second hook', () => {
    const helperOnly = ctxOf({ 'classes.dex': buildDex({ classes: [VIEW([...WAIT, ...RET]), helperStub] }) });
    expect(fixSurfaceWaitDeadlock.detect(helperOnly)).toBe('notApplied');
    fixSurfaceWaitDeadlock.apply(helperOnly);
    expect(fixSurfaceWaitDeadlock.detect(helperOnly)).toBe('applied');
    expect(dexOf(helperOnly).classNames().filter((n) => n === SURFACE_WAIT_CLASS)).toHaveLength(1);

    const hookOnly = ctxOf({ 'classes.dex': buildDex({ classes: [VIEW([...AWAIT_CALL, ...RET])] }) });
    expect(fixSurfaceWaitDeadlock.detect(hookOnly)).toBe('notApplied');
    fixSurfaceWaitDeadlock.apply(hookOnly);
    expect(fixSurfaceWaitDeadlock.detect(hookOnly)).toBe('applied');
    const d = dexOf(hookOnly), view = d.findClass(GL)!;
    expect(insnsOf(view, view.findMethod('readySurface')!).map((i) => calleeOf(d, i)?.cls).filter(Boolean)).toEqual([SURFACE_WAIT_CLASS]);
  });
});
