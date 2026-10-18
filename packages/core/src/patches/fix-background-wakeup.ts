import { ACC, CodeBuilder, type DexFile } from '../dex';
import { JARLPENGUIN_CREDITS } from './credits';
import { makeMethodRewritePatch, type MethodRewriteSpec } from './method-rewrite';

export const LIFECYCLE_CLASS = 'Lcom/apportable/Lifecycle;';
export const WAKE_METHOD = 'blockheadsClubWake';
const HANDLER = 'Landroid/os/Handler;';

/** `testInBackground()`; with `wake`, the helper runs after each pair of native lifecycle notifications. */
function body(dex: DexFile, wake: boolean): CodeBuilder {
  const f = (name: string): number => dex.field(LIFECYCLE_CLASS, name, 'Z');
  const call = (name: string): number => dex.method(LIFECYCLE_CLASS, name, 'V', []);
  const b = new CodeBuilder({ registers: 1 });
  const tick = (): void => { if (wake) b.op('invoke-static', call(WAKE_METHOD)); };
  b.op('sget-boolean', 0, f('sNativeApplicationInBackground')).op('if-eqz', 0, 'else')
    .op('sget-boolean', 0, f('sWindowHasFocus')).op('if-eqz', 0, 'else')
    .op('sget-boolean', 0, f('sActivityPaused')).op('if-nez', 0, 'else')
    .op('sget-boolean', 0, f('sContextHasSurface')).op('if-eqz', 0, 'else')
    .op('sget-boolean', 0, f('sNativeApplicationStarted')).op('if-eqz', 0, 'else')
    .op('const/4', 0, 0).op('sput-boolean', 0, f('sNativeApplicationInBackground'))
    .op('invoke-static', call('testHasValidContext'))
    .op('invoke-static', call('applicationWillEnterForeground'))
    .op('invoke-static', call('applicationDidBecomeActive'));
  tick();
  b.label('ret').op('return-void')
    .label('else').op('sget-boolean', 0, f('sNativeApplicationInBackground')).op('if-nez', 0, 'ret')
    .op('sget-boolean', 0, f('sActivityPaused')).op('if-nez', 0, 'stopped')
    .op('sget-boolean', 0, f('sActivityWasStopped')).op('if-eqz', 0, 'ret')
    .label('stopped').op('sget-boolean', 0, f('sNativeApplicationStarted')).op('if-eqz', 0, 'ret')
    .op('const/4', 0, 1).op('sput-boolean', 0, f('sNativeApplicationInBackground'))
    .op('invoke-static', call('testHasValidContext'))
    .op('invoke-static', call('applicationWillResignActive'))
    .op('invoke-static', call('applicationDidEnterBackground'));
  tick();
  return b.op('goto', 'ret');
}

/**
 * The lifecycle entry points hand their work to the game thread's run loop but never wake it, so after returning to
 * the game the screen can stay frozen until it is touched. After each native lifecycle notification an empty message
 * is now posted to the game thread's handler, which makes its run loop tick. Experimental, so off by default.
 */
export const fixBackgroundWakeupSpec: MethodRewriteSpec = {
  id: 'fix-background-wakeup',
  credits: JARLPENGUIN_CREDITS,
  optIn: true,
  cls: LIFECYCLE_CLASS,
  method: { name: 'testInBackground', params: [], returnType: 'V' },
  original: (dex) => body(dex, false),
  patched: (dex) => body(dex, true),
  prepare(dex, cls) {
    const b = new CodeBuilder({ registers: 2, outs: 2 })
      .op('invoke-static', dex.method('Lcom/apportable/MainThread;', 'getHandler', HANDLER, [])).op('move-result-object', 0)
      .op('if-eqz', 0, 'end').op('const/4', 1, 0)
      .op('invoke-virtual', dex.method(HANDLER, 'sendEmptyMessage', 'Z', ['I']), 0, 1)
      .label('end').op('return-void');
    cls.addMethod({ name: WAKE_METHOD, returnType: 'V', params: [], access: ACC.PUBLIC | ACC.STATIC, code: b });
  },
  logMessage: 'Lifecycle.testInBackground() now wakes the game thread after lifecycle changes',
};
export const fixBackgroundWakeup = makeMethodRewritePatch(fixBackgroundWakeupSpec);
