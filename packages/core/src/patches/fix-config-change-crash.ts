import { ACC, CodeBuilder, type DexFile, type DexSet } from '../dex';
import { callsClass, editDex, openDexSet } from './dex-support';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const LOOP_GUARD_CLASS = 'Lcom/blockheadsclub/patch/LoopGuard;';
/** The only exception the guard swallows (a hidden class, so it is matched by name). */
export const WRONG_THREAD_EXCEPTION = 'android.view.ViewRootImpl$CalledFromWrongThreadException';
const ACTIVITY_CLASS = 'Lcom/apportable/activity/VerdeActivity;';
const BUNDLE = 'Landroid/os/Bundle;';
const OBJ = 'Ljava/lang/Object;', STR = 'Ljava/lang/String;', THROWABLE = 'Ljava/lang/Throwable;';
const LOOPER = 'Landroid/os/Looper;', HANDLER = 'Landroid/os/Handler;', RUNNABLE = 'Ljava/lang/Runnable;';

/**
 * Adds `LoopGuard implements Runnable`:
 * - `install()` (static, once per process): posts a new LoopGuard to the main looper; never throws.
 * - `run()`: runs `Looper.loop()` inside that message, so every later main-thread message is dispatched below it. A
 *   `CalledFromWrongThreadException` escaping a message is logged and the loop re-entered; anything else is rethrown
 *   and crashes the app as before.
 */
function addGuard(dex: DexFile): void {
  const m = (cls: string, name: string, ret: string, ...params: string[]): number => dex.method(cls, name, ret, params);
  const cls = dex.addClass({ descriptor: LOOP_GUARD_CLASS, access: ACC.PUBLIC | ACC.FINAL, interfaces: [RUNNABLE], sourceFile: 'LoopGuard.java' });
  const installed = cls.addStaticField('installed', 'Z', ACC.PRIVATE);
  const throwable = dex.type(THROWABLE);
  const init = new CodeBuilder({ registers: 1, outs: 1 })
    .op('invoke-direct', m(OBJ, '<init>', 'V'), 0).op('return-void');
  // v0 handler / exception, v1 looper / guard
  const install = new CodeBuilder({ registers: 2, outs: 2 })
    .op('sget-boolean', 0, installed).op('if-nez', 0, 'done')
    .op('const/4', 0, 1).op('sput-boolean', 0, installed)
    .label('try')
    .op('new-instance', 0, dex.type(HANDLER))
    .op('invoke-static', m(LOOPER, 'getMainLooper', LOOPER)).op('move-result-object', 1)
    .op('invoke-direct', m(HANDLER, '<init>', 'V', LOOPER), 0, 1)
    .op('new-instance', 1, dex.type(LOOP_GUARD_CLASS))
    .op('invoke-direct', m(LOOP_GUARD_CLASS, '<init>', 'V'), 1)
    .op('invoke-virtual', m(HANDLER, 'post', 'Z', RUNNABLE), 0, 1)
    .label('end')
    .label('done')
    .op('return-void')
    .label('catch').op('move-exception', 0).op('goto', 'done')
    .tryCatch({ start: 'try', end: 'end', handlers: [{ type: throwable, label: 'catch' }] });
  // v0 exception, v1/v2 temps, v3 = this
  const run = new CodeBuilder({ registers: 4, outs: 3 })
    .label('loop')
    .op('invoke-static', m(LOOPER, 'loop', 'V'))
    .label('looped')
    .op('return-void')
    .label('catch').op('move-exception', 0)
    .op('invoke-virtual', m(OBJ, 'getClass', 'Ljava/lang/Class;'), 0).op('move-result-object', 1)
    .op('invoke-virtual', m('Ljava/lang/Class;', 'getName', STR), 1).op('move-result-object', 1)
    .op('const-string', 2, dex.string(WRONG_THREAD_EXCEPTION))
    .op('invoke-virtual', m(STR, 'equals', 'Z', OBJ), 2, 1).op('move-result', 1).op('if-eqz', 1, 'rethrow')
    .op('const-string', 1, dex.string('BlockheadsPatcher'))
    .op('const-string', 2, dex.string('ignored a configuration change on the wrong thread'))
    .op('invoke-static', m('Landroid/util/Log;', 'w', 'I', STR, STR, THROWABLE), 1, 2, 0)
    .op('goto', 'loop')
    .label('rethrow').op('throw', 0)
    .tryCatch({ start: 'loop', end: 'looped', handlers: [{ type: throwable, label: 'catch' }] });
  cls.addMethod({ name: '<init>', returnType: 'V', params: [], access: ACC.PUBLIC | ACC.CONSTRUCTOR, code: init });
  cls.addMethod({ name: 'install', returnType: 'V', params: [], access: ACC.PUBLIC | ACC.STATIC, code: install });
  cls.addMethod({ name: 'run', returnType: 'V', params: [], access: ACC.PUBLIC, code: run });
}

function state(set: DexSet) {
  const hit = set.findClass(ACTIVITY_CLASS);
  const onCreate = hit?.cls.findMethod('onCreate', [BUNDLE], 'V');
  if (!hit || !onCreate?.hasCode) return undefined;
  return { ...hit, onCreate, hooked: callsClass(hit.dex, hit.cls, onCreate, LOOP_GUARD_CLASS), hasGuard: !!set.findClass(LOOP_GUARD_CLASS) };
}

function detect(ctx: PatchContext): PatchStatus {
  const set = openDexSet(ctx);
  const s = set && state(set);
  if (!s) return 'incompatible';
  return s.hooked && s.hasGuard ? 'applied' : 'notApplied';
}

/**
 * The game creates its window on Apportable's own thread ("MainThread"), not on the Android UI thread. When Android
 * hands the activity a configuration change it declares as handled (fold/unfold, split screen, font scale, dark mode),
 * `ViewRootImpl.updateConfiguration` -> `requestLayout` runs on the UI thread, fails the thread check and the uncaught
 * `CalledFromWrongThreadException` kills the app. `VerdeActivity.onCreate` (the first game code on the UI thread) now
 * installs `LoopGuard`, which keeps the main looper running past exactly that exception.
 */
export const fixConfigChangeCrash: Patch = {
  id: 'fix-config-change-crash',
  version: 1,
  nameKey: 'patch.fix-config-change-crash.name',
  descriptionKey: 'patch.fix-config-change-crash.description',
  appliesTo: { packageName: 'com.noodlecake.blockheads' },
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`fix-config-change-crash cannot be applied (status: ${status})`, 'cannotApply', { status });
    const set = openDexSet(ctx)!;
    const s = state(set)!;
    editDex('fix-config-change-crash', () => {
      if (!s.hasGuard) addGuard(s.dex);
      if (!s.hooked) {
        const install = s.dex.method(LOOP_GUARD_CLASS, 'install', 'V', []);
        s.cls.prependCode(s.onCreate, (registers) => new CodeBuilder({ registers }).op('invoke-static', install));
      }
      set.commit();
    });
    ctx.log('VerdeActivity.onCreate installs the main-looper guard for configuration changes');
  },
};
