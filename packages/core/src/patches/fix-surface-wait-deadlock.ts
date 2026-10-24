import { ACC, CodeBuilder, type DexClass, type DexFile, type DexSet, type MethodInfo } from '../dex';
import { calleeOf, editDex, insnsOf, openDexSet } from './dex-support';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const SURFACE_WAIT_CLASS = 'Lcom/blockheadsclub/patch/SurfaceWait;';
/** Longest single wait (ms) for a surface; while the game is in the background each expiry abandons the wait. */
export const SURFACE_POLL_MS = 150;
const GL_SURFACE_VIEW = 'Lcom/apportable/gl/GLSurfaceView;', LIFECYCLE = 'Lcom/apportable/Lifecycle;';
const OBJ = 'Ljava/lang/Object;', ISE = 'Ljava/lang/IllegalStateException;', IE = 'Ljava/lang/InterruptedException;';

/**
 * Adds `SurfaceWait.await(Object lock)`, a drop-in for `lock.wait()` inside `GLSurfaceView.readySurface()`:
 * waits at most SURFACE_POLL_MS; when that ends (or the wait is interrupted) and the game is in the background, throws
 * an `IllegalStateException`, which unwinds `readySurface()` (its monitor is released by its own catch-all handler).
 * `MainThread.runTickActions()` catches it, and the game thread goes on to drain its Looper.
 * Registers: v0/v1 temps (wait time as a pair), v2 spare, v3 = lock.
 */
function addHelper(dex: DexFile): void {
  const m = (cls: string, name: string, ret: string, ...params: string[]): number => dex.method(cls, name, ret, params);
  const cls = dex.addClass({ descriptor: SURFACE_WAIT_CLASS, access: ACC.PUBLIC | ACC.FINAL, sourceFile: 'SurfaceWait.java' });
  const await_ = new CodeBuilder({ registers: 4, outs: 3 })
    .label('try').op('const-wide/16', 0, SURFACE_POLL_MS).op('invoke-virtual', m(OBJ, 'wait', 'V', 'J'), 3, 0, 1)
    .label('end')
    .label('check').op('invoke-static', m(LIFECYCLE, 'isInBackground', 'Z')).op('move-result', 0).op('if-eqz', 0, 'done')
    .op('new-instance', 0, dex.type(ISE)).op('const-string', 1, dex.string('surface wait abandoned: game is in the background'))
    .op('invoke-direct', m(ISE, '<init>', 'V', 'Ljava/lang/String;'), 0, 1).op('throw', 0)
    .label('done').op('return-void')
    .label('interrupted').op('move-exception', 0).op('goto', 'check')
    .tryCatch({ start: 'try', end: 'end', handlers: [{ type: dex.type(IE), label: 'interrupted' }] });
  cls.addMethod({ name: 'await', returnType: 'V', params: [OBJ], access: ACC.PUBLIC | ACC.STATIC, code: await_ });
}

interface Site { set: DexSet; dex: DexFile; cls: DexClass; method: MethodInfo; at: number | undefined; hasHelper: boolean }

function locate(ctx: PatchContext): Site | undefined {
  const set = openDexSet(ctx);
  const hit = set?.findClass(GL_SURFACE_VIEW);
  const method = hit?.cls.findMethod('readySurface', [], 'V');
  if (!set || !hit || !method?.hasCode) return undefined;
  const calls = insnsOf(hit.cls, method).filter((i) => {
    const c = calleeOf(hit.dex, i);
    return i.name === 'invoke-virtual' && c?.cls === OBJ && c.name === 'wait' && c.params.length === 0 && c.ret === 'V';
  });
  const hooked = insnsOf(hit.cls, method).some((i) => calleeOf(hit.dex, i)?.cls === SURFACE_WAIT_CLASS);
  if (!hooked && calls.length !== 1) return undefined;
  return { set, dex: hit.dex, cls: hit.cls, method, at: hooked ? undefined : calls[0]!.at, hasHelper: !!set.findClass(SURFACE_WAIT_CLASS) };
}

function detect(ctx: PatchContext): PatchStatus {
  const s = locate(ctx);
  if (!s) return 'incompatible';
  return s.at === undefined && s.hasHelper ? 'applied' : 'notApplied';
}

/**
 * Backgrounding the game can freeze it with a black screen. `Activity.performStop` ends in
 * `WindowManagerGlobal.setStoppedState`, which runs a task on the thread of every ViewRootImpl and waits for it; the
 * game owns four such windows on its own game thread ("MainThread"). That thread can be inside
 * `GLSurfaceView.readySurface()` waiting, with no time limit, for a surface that only the (now blocked) UI thread can
 * create again: a deadlock that no later wake-up can undo (thread dumps from the phone's ANR reports show exactly this).
 * The one `Object.wait()` in `readySurface()` now goes through `SurfaceWait.await`, which gives up while the game is in
 * the background so the game thread can run its Looper and the stop completes.
 */
export const fixSurfaceWaitDeadlock: Patch = {
  id: 'fix-surface-wait-deadlock',
  version: 1,
  nameKey: 'patch.fix-surface-wait-deadlock.name',
  descriptionKey: 'patch.fix-surface-wait-deadlock.description',
  appliesTo: { packageName: 'com.noodlecake.blockheads' },
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`fix-surface-wait-deadlock cannot be applied (status: ${status})`, 'cannotApply', { status });
    const s = locate(ctx)!;
    editDex('fix-surface-wait-deadlock', () => {
      if (!s.hasHelper) addHelper(s.dex);
      if (s.at !== undefined) {
        const at = s.at;
        const target = s.dex.method(SURFACE_WAIT_CLASS, 'await', 'V', [OBJ]);
        // invoke-virtual {vA}, wait()V  ->  invoke-static {vA}, SurfaceWait.await(Object)V (same format, same size)
        s.cls.patchInsns(s.method, (u) => { u[at] = (u[at]! & 0xff00) | 0x71; u[at + 1] = target; });
      }
      s.set.commit();
    });
    ctx.log('GLSurfaceView.readySurface() no longer waits for a surface forever while the game is in the background');
  },
};
