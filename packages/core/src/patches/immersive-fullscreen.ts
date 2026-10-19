import { ACC, CodeBuilder, type DexClass, type DexFile, type DexSet, type MethodInfo } from '../dex';
import { callsClass, editDex, openDexSet } from './dex-support';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const IMMERSIVE_CLASS = 'Lcom/blockheadsclub/patch/Immersive;';
/** Below this API level (no WindowInsetsController) the game keeps its own legacy immersive flags. */
export const IMMERSIVE_MIN_API = 30;
const ACTIVITY_CLASS = 'Lcom/apportable/activity/VerdeActivity;';
const ACTIVITY = 'Landroid/app/Activity;', WINDOW = 'Landroid/view/Window;', VIEW = 'Landroid/view/View;';
const CONTROLLER = 'Landroid/view/WindowInsetsController;';
const OBJ = 'Ljava/lang/Object;', RUNNABLE = 'Ljava/lang/Runnable;', THROWABLE = 'Ljava/lang/Throwable;';

/**
 * Adds `Immersive implements Runnable`. Nothing here may throw into the game, so both entry points swallow Throwable.
 * - `hide(Activity)`: on API 30+ remembers the activity and posts a new `Immersive` to its decor view, so `run()` runs
 *   on the thread owning that window (the UI thread; Apportable's own thread must not touch it). Returns true when
 *   posted, so the game's `hideSystemUI` skips its own flags; false below API 30 or on any error (game behaviour).
 * - `run()`: in multi-window (split screen, pop-up / freeform) shows the system bars; otherwise hides them, a swipe
 *   from an edge shows them transiently (`BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`).
 */
function addHelper(dex: DexFile): void {
  const m = (cls: string, name: string, ret: string, ...params: string[]): number => dex.method(cls, name, ret, params);
  const cls = dex.addClass({ descriptor: IMMERSIVE_CLASS, access: ACC.PUBLIC | ACC.FINAL, interfaces: [RUNNABLE], sourceFile: 'Immersive.java' });
  const activity = cls.addStaticField('activity', ACTIVITY, ACC.PRIVATE);
  const sdk = dex.field('Landroid/os/Build$VERSION;', 'SDK_INT', 'I');
  const throwable = dex.type(THROWABLE);
  const init = new CodeBuilder({ registers: 1, outs: 1 }).op('invoke-direct', m(OBJ, '<init>', 'V'), 0).op('return-void');
  // v0 sdk / view / result, v1 literal / runnable, v2 = activity
  const hide = new CodeBuilder({ registers: 3, outs: 2 })
    .label('try')
    .op('sget', 0, sdk).op('const/16', 1, IMMERSIVE_MIN_API).op('if-lt', 0, 1, 'game')
    .op('sput-object', 2, activity)
    .op('invoke-virtual', m(ACTIVITY, 'getWindow', WINDOW), 2).op('move-result-object', 0)
    .op('invoke-virtual', m(WINDOW, 'getDecorView', VIEW), 0).op('move-result-object', 0)
    .op('new-instance', 1, dex.type(IMMERSIVE_CLASS))
    .op('invoke-direct', m(IMMERSIVE_CLASS, '<init>', 'V'), 1)
    .op('invoke-virtual', m(VIEW, 'post', 'Z', RUNNABLE), 0, 1).op('move-result', 0)
    .label('end')
    .op('return', 0)
    .label('catch').op('move-exception', 0)
    .label('game').op('const/4', 0, 0).op('return', 0)
    .tryCatch({ start: 'try', end: 'end', handlers: [{ type: throwable, label: 'catch' }] });
  // v0 activity / behaviour, v1 multi-window, v2 controller, v3 types, v4 = this
  const run = new CodeBuilder({ registers: 5, outs: 2 })
    .label('try')
    .op('sget-object', 0, activity).op('if-eqz', 0, 'done')
    .op('invoke-virtual', m(ACTIVITY, 'isInMultiWindowMode', 'Z'), 0).op('move-result', 1)
    .op('invoke-virtual', m(ACTIVITY, 'getWindow', WINDOW), 0).op('move-result-object', 2)
    .op('invoke-virtual', m(WINDOW, 'getInsetsController', CONTROLLER), 2).op('move-result-object', 2)
    .op('if-eqz', 2, 'done')
    .op('invoke-static', m('Landroid/view/WindowInsets$Type;', 'systemBars', 'I')).op('move-result', 3)
    .op('if-nez', 1, 'show')
    .op('const/4', 0, 2) // BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    .op('invoke-interface', m(CONTROLLER, 'setSystemBarsBehavior', 'V', 'I'), 2, 0)
    .op('invoke-interface', m(CONTROLLER, 'hide', 'V', 'I'), 2, 3)
    .op('goto', 'done')
    .label('show')
    .op('invoke-interface', m(CONTROLLER, 'show', 'V', 'I'), 2, 3)
    .label('end')
    .label('done')
    .op('return-void')
    .label('catch').op('move-exception', 0).op('goto', 'done')
    .tryCatch({ start: 'try', end: 'end', handlers: [{ type: throwable, label: 'catch' }] });
  cls.addMethod({ name: '<init>', returnType: 'V', params: [], access: ACC.PUBLIC | ACC.CONSTRUCTOR, code: init });
  cls.addMethod({ name: 'hide', returnType: 'Z', params: [ACTIVITY], access: ACC.PUBLIC | ACC.STATIC, code: hide });
  cls.addMethod({ name: 'run', returnType: 'V', params: [], access: ACC.PUBLIC, code: run });
}

/** [method, params, skip the rest of the method when the helper returns true]. */
const HOOKS: [string, string[], boolean][] = [
  ['hideSystemUI', [], true],
  ['onConfigurationChanged', ['Landroid/content/res/Configuration;'], false],
];
interface Hook { method: MethodInfo; replaces: boolean; hooked: boolean }

function state(set: DexSet): { dex: DexFile; cls: DexClass; hooks: Hook[]; hasHelper: boolean } | undefined {
  const hit = set.findClass(ACTIVITY_CLASS);
  if (!hit) return undefined;
  const hooks: Hook[] = [];
  for (const [name, params, replaces] of HOOKS) {
    const method = hit.cls.findMethod(name, params, 'V');
    const code = method?.hasCode ? hit.cls.codeOf(method) : undefined;
    // replacing needs one scratch register below the arguments for the helper's result
    if (!code || (replaces && code.registers <= code.ins)) return undefined;
    hooks.push({ method: method!, replaces, hooked: callsClass(hit.dex, hit.cls, method!, IMMERSIVE_CLASS) });
  }
  return { ...hit, hooks, hasHelper: !!set.findClass(IMMERSIVE_CLASS) };
}

function detect(ctx: PatchContext): PatchStatus {
  const set = openDexSet(ctx);
  const s = set && state(set);
  if (!s) return 'incompatible';
  return s.hasHelper && s.hooks.every((h) => h.hooked) ? 'applied' : 'notApplied';
}

/**
 * The game already asks for sticky immersive mode from `VerdeActivity.hideSystemUI` (legacy flags, on onCreate,
 * onResume and every focus change), even in split screen or a pop-up window, and not again after a configuration
 * change. On API 30+ `hideSystemUI` now runs our version instead (posted to the window's own thread,
 * `WindowInsetsController`, bars shown rather than hidden in multi-window), and `onConfigurationChanged` re-applies it
 * (rotation, fold / unfold, entering or leaving multi-window). The display cutout mode stays `default` on purpose: with
 * `shortEdges` the game draws its top-centre HUD (the blockhead portrait) under the camera of a punch-hole phone.
 */
export const immersiveFullscreen: Patch = {
  id: 'immersive-fullscreen',
  version: 1,
  nameKey: 'patch.immersive-fullscreen.name',
  descriptionKey: 'patch.immersive-fullscreen.description',
  appliesTo: { packageName: 'com.noodlecake.blockheads' },
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`immersive-fullscreen cannot be applied (status: ${status})`, 'cannotApply', { status });
    const set = openDexSet(ctx)!;
    const s = state(set)!;
    const missing = s.hooks.filter((h) => !h.hooked);
    editDex('immersive-fullscreen', () => {
      if (!s.hasHelper) addHelper(s.dex);
      const hide = s.dex.method(IMMERSIVE_CLASS, 'hide', 'Z', [ACTIVITY]);
      for (const h of missing) {
        s.cls.prependCode(h.method, (registers, ins) => {
          const b = new CodeBuilder({ registers, outs: 1 }).op('invoke-static/range', hide, registers - ins, 1);
          return h.replaces ? b.op('move-result', 0).op('if-eqz', 0, 'game').op('return-void').label('game') : b;
        });
      }
      set.commit();
    });
    ctx.log(`immersive-fullscreen: VerdeActivity hooks (${missing.map((h) => h.method.name).join(', ')})`);
  },
};
