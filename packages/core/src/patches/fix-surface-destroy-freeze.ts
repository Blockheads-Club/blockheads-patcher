import { CodeBuilder, type DexFile } from '../dex';
import { JARLPENGUIN_CREDITS } from './credits';
import { makeMethodRewritePatch, type MethodRewriteSpec } from './method-rewrite';

export const GL_SURFACE_VIEW_CLASS = 'Lcom/apportable/gl/GLSurfaceView;';
/** Longest time the UI thread waits for the game thread to release the surface. */
export const SURFACE_WAIT_MS = 250;
const OBJ = 'Ljava/lang/Object;', THREAD = 'Ljava/lang/Thread;', HANDLER = 'Landroid/os/Handler;', CLOCK = 'Landroid/os/SystemClock;';
const IE = 'Ljava/lang/InterruptedException;';

/** `surfaceDestroyed()` as shipped: marks the surface gone, then waits on `mLock` with no timeout. */
function original(dex: DexFile): CodeBuilder {
  const f = (name: string, type: string): number => dex.field(GL_SURFACE_VIEW_CLASS, name, type);
  const m = (cls: string, name: string, ret: string, ...params: string[]): number => dex.method(cls, name, ret, params);
  return new CodeBuilder({ registers: 3, outs: 1 })
    .op('iget-object', 1, 2, f('mLock', OBJ)).op('monitor-enter', 1)
    .op('const/4', 0, 0).op('iput-boolean', 0, 2, f('mHasSurface', 'Z'))
    .op('iget-object', 0, 2, f('mLock', OBJ)).op('invoke-virtual', m(OBJ, 'notifyAll', 'V'), 0)
    .label('loop').op('iget-boolean', 0, 2, f('mWaitingForSurface', 'Z')).op('if-nez', 0, 'out')
    .op('iget-boolean', 0, 2, f('mExited', 'Z')).op('if-nez', 0, 'out')
    .op('iget-object', 0, 2, f('mLock', OBJ))
    .label('w0').op('invoke-virtual', m(OBJ, 'wait', 'V'), 0)
    .label('w1').op('goto', 'loop')
    .label('ie').op('move-exception', 0)
    .op('invoke-static', m(THREAD, 'currentThread', THREAD)).op('move-result-object', 0)
    .op('invoke-virtual', m(THREAD, 'interrupt', 'V'), 0).op('goto', 'loop')
    .label('any').op('move-exception', 0).op('monitor-exit', 1).op('throw', 0)
    .label('out').op('monitor-exit', 1).op('return-void');
}

/**
 * Replacement: wake the game thread first (an empty message on its handler makes its run loop tick, which is where
 * it notices the lost surface), then wait for it for at most SURFACE_WAIT_MS. An interrupt is re-asserted and ends
 * the wait instead of spinning. Registers: v0 temp, v1 lock, v2/v3 deadline, v4/v5 remaining, v6/v7 zero, v8 this.
 */
function patched(dex: DexFile): CodeBuilder {
  const f = (name: string, type: string): number => dex.field(GL_SURFACE_VIEW_CLASS, name, type);
  const m = (cls: string, name: string, ret: string, ...params: string[]): number => dex.method(cls, name, ret, params);
  return new CodeBuilder({ registers: 9, outs: 3 })
    .op('invoke-static', m('Lcom/apportable/MainThread;', 'getHandler', HANDLER)).op('move-result-object', 0)
    .op('if-eqz', 0, 'go').op('const/4', 1, 0)
    .op('invoke-virtual', m(HANDLER, 'sendEmptyMessage', 'Z', 'I'), 0, 1)
    .label('go').op('invoke-static', m(CLOCK, 'uptimeMillis', 'J')).op('move-result-wide', 2)
    .op('const-wide/16', 4, SURFACE_WAIT_MS).op('add-long/2addr', 2, 4)
    .op('const-wide/16', 6, 0)
    .op('iget-object', 1, 8, f('mLock', OBJ)).op('monitor-enter', 1)
    .label('a').op('const/4', 0, 0).op('iput-boolean', 0, 8, f('mHasSurface', 'Z'))
    .op('invoke-virtual', m(OBJ, 'notifyAll', 'V'), 1)
    .label('loop').op('iget-boolean', 0, 8, f('mWaitingForSurface', 'Z')).op('if-nez', 0, 'out')
    .op('iget-boolean', 0, 8, f('mExited', 'Z')).op('if-nez', 0, 'out')
    .op('invoke-static', m(CLOCK, 'uptimeMillis', 'J')).op('move-result-wide', 4)
    .op('sub-long', 4, 2, 4).op('cmp-long', 0, 4, 6).op('if-lez', 0, 'out')
    .label('w0').op('invoke-virtual', m(OBJ, 'wait', 'V', 'J'), 1, 4, 5)
    .label('w1').op('goto', 'loop')
    .label('ie').op('move-exception', 0)
    .op('invoke-static', m(THREAD, 'currentThread', THREAD)).op('move-result-object', 0)
    .op('invoke-virtual', m(THREAD, 'interrupt', 'V'), 0)
    .label('out').op('monitor-exit', 1)
    .label('end').op('return-void')
    .label('any').op('move-exception', 0).op('monitor-exit', 1).op('throw', 0)
    .tryCatch({ start: 'a', end: 'w0', catchAll: 'any' })
    .tryCatch({ start: 'w0', end: 'w1', handlers: [{ type: dex.type(IE), label: 'ie' }], catchAll: 'any' })
    .tryCatch({ start: 'w1', end: 'end', catchAll: 'any' });
}

/**
 * When the game activity is stopped (home, share sheet, photo picker, web pages), the UI thread waits in
 * `GLSurfaceView.surfaceDestroyed()` with no timeout for a game thread that may itself be waiting for the UI thread:
 * the game freezes. The wait is now bounded and the game thread is woken first.
 */
export const fixSurfaceDestroyFreezeSpec: MethodRewriteSpec = {
  id: 'fix-surface-destroy-freeze',
  credits: JARLPENGUIN_CREDITS,
  cls: GL_SURFACE_VIEW_CLASS,
  method: { name: 'surfaceDestroyed', params: [], returnType: 'V' },
  original,
  patched,
  logMessage: `GLSurfaceView.surfaceDestroyed() now waits at most ${SURFACE_WAIT_MS} ms`,
};
export const fixSurfaceDestroyFreeze = makeMethodRewritePatch(fixSurfaceDestroyFreezeSpec);
