import { ANDROID_NS, ValueType, insertElement } from '../axml';
import { ACC, CodeBuilder, type DexClass, type DexFile, type DexSet, type MethodInfo } from '../dex';
import { callsClass, editDex, openDexSet } from './dex-support';
import { BLOCKHEADS_PACKAGE, findActivityByName, findApplication } from './manifest-flags';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const SCREEN_RESTART_CLASS = 'Lcom/blockheadsclub/patch/ScreenRestart;';
export const RESTART_ACTIVITY_CLASS = 'Lcom/blockheadsclub/patch/RestartActivity;';
export const RESTART_ACTIVITY_NAME = 'com.blockheadsclub.patch.RestartActivity';
/** Smallest display width (dp) from which the game treats the screen as a tablet (same threshold as `tablet-layout`). */
export const RESTART_MIN_DP = 600;
/** Time (ms) the game gets to pause and save before its process is stopped, and before the new process is started. */
export const KILL_DELAY_MS = 2000;
export const RELAUNCH_DELAY_MS = 2500;
const ACTIVITY_CLASS = 'Lcom/apportable/activity/VerdeActivity;';
const ACTIVITY = 'Landroid/app/Activity;', CONFIG = 'Landroid/content/res/Configuration;', BUNDLE = 'Landroid/os/Bundle;';
const INTENT = 'Landroid/content/Intent;', HANDLER = 'Landroid/os/Handler;', LOOPER = 'Landroid/os/Looper;', PROCESS = 'Landroid/os/Process;';
const OBJ = 'Ljava/lang/Object;', RUNNABLE = 'Ljava/lang/Runnable;', THROWABLE = 'Ljava/lang/Throwable;', CONTEXT = 'Landroid/content/Context;';
const METRICS = 'Landroid/util/DisplayMetrics;', DISPLAY = 'Landroid/view/Display;', WM = 'Landroid/view/WindowManager;', STR = 'Ljava/lang/String;';
const PM = 'Landroid/content/pm/PackageManager;';
const ID = { name: 0x01010003, theme: 0x01010000, exported: 0x01010010, process: 0x01010011, excludeFromRecents: 0x01010017 };
/** @android:style/Theme.Translucent.NoTitleBar */
const THEME_TRANSLUCENT = 0x01030010;

/**
 * Adds two classes.
 * `ScreenRestart implements Runnable` (nothing in it may throw into the game):
 * - `start(Activity)` records whether the physical display is "large" (smallest side >= 600 dp);
 * - `changed(Activity, Configuration)` compares that with the display now and, when it flipped (a foldable was folded or
 *   unfolded; never in split screen / pop-up windows, which do not change the display), starts `RestartActivity`, finishes
 *   the game activity and schedules `run()`, which stops the game's process if Android has not done so already;
 * `RestartActivity` lives in its own process (`:restart`), waits for the game to save and die, starts the game's launch
 * intent again and stops itself. A fresh process is the only way to re-run what the game decides once at start-up
 * (content size, tablet layout), because the native side is not written to run twice in one process.
 */
function addHelper(dex: DexFile): void {
  const m = (cls: string, name: string, ret: string, ...params: string[]): number => dex.method(cls, name, ret, params);
  const throwable = dex.type(THROWABLE);
  const base = dex.field(SCREEN_RESTART_CLASS, 'base', 'I');
  const cls = dex.addClass({ descriptor: SCREEN_RESTART_CLASS, access: ACC.PUBLIC | ACC.FINAL, interfaces: [RUNNABLE], sourceFile: 'ScreenRestart.java' });
  cls.addStaticField('base', 'I', ACC.PRIVATE);
  const init = new CodeBuilder({ registers: 1, outs: 1 }).op('invoke-direct', m(OBJ, '<init>', 'V'), 0).op('return-void');
  // 1 = large display, 0 = small, -1 = unknown or multi-window. v7 = activity
  const size = new CodeBuilder({ registers: 8, outs: 2 })
    .label('try')
    .op('invoke-virtual', m(ACTIVITY, 'isInMultiWindowMode', 'Z'), 7).op('move-result', 0).op('if-nez', 0, 'neg')
    .op('new-instance', 1, dex.type(METRICS)).op('invoke-direct', m(METRICS, '<init>', 'V'), 1)
    .op('invoke-virtual', m(ACTIVITY, 'getWindowManager', WM), 7).op('move-result-object', 0)
    .op('invoke-interface', m(WM, 'getDefaultDisplay', DISPLAY), 0).op('move-result-object', 0)
    .op('invoke-virtual', m(DISPLAY, 'getRealMetrics', 'V', METRICS), 0, 1)
    .op('iget', 2, 1, dex.field(METRICS, 'widthPixels', 'I')).op('iget', 3, 1, dex.field(METRICS, 'heightPixels', 'I'))
    .op('invoke-static', m('Ljava/lang/Math;', 'min', 'I', 'I', 'I'), 2, 3).op('move-result', 2)
    .op('const/16', 3, 160).op('mul-int', 2, 2, 3)
    .op('iget', 3, 1, dex.field(METRICS, 'densityDpi', 'I')).op('div-int', 2, 2, 3)
    .op('const/16', 3, RESTART_MIN_DP).op('if-lt', 2, 3, 'small')
    .op('const/4', 0, 1).op('return', 0)
    .label('small').op('const/4', 0, 0).op('return', 0)
    .label('end')
    .label('catch').op('move-exception', 0)
    .label('neg').op('const/4', 0, -1).op('return', 0)
    .tryCatch({ start: 'try', end: 'end', handlers: [{ type: throwable, label: 'catch' }] });
  // v1 = activity
  const start = new CodeBuilder({ registers: 2, outs: 1 })
    .op('invoke-static', m(SCREEN_RESTART_CLASS, 'size', 'I', ACTIVITY), 1).op('move-result', 0)
    .op('add-int/lit8', 0, 0, 1).op('sput', 0, base).op('return-void');
  // v4 = activity, v5 = configuration (unused). v0 size now, v1 recorded, v2 now + 1
  const changed = new CodeBuilder({ registers: 6, outs: 1 })
    .label('try')
    .op('invoke-static', m(SCREEN_RESTART_CLASS, 'size', 'I', ACTIVITY), 4).op('move-result', 0)
    .op('sget', 1, base).op('if-eqz', 1, 'done')
    .op('if-ltz', 0, 'done')
    .op('add-int/lit8', 2, 0, 1).op('if-eq', 2, 1, 'done')
    .op('sput', 2, base)
    .op('invoke-static', m(SCREEN_RESTART_CLASS, 'restart', 'V', ACTIVITY), 4)
    .label('end')
    .label('done').op('return-void')
    .label('catch').op('move-exception', 0).op('goto', 'done')
    .tryCatch({ start: 'try', end: 'end', handlers: [{ type: throwable, label: 'catch' }] });
  // v5 = activity; v0 intent / handler, v1 class / looper, v2 runnable, v3+v4 delay
  const restart = new CodeBuilder({ registers: 6, outs: 5 })
    .op('new-instance', 0, dex.type(INTENT)).op('const-class', 1, dex.type(RESTART_ACTIVITY_CLASS))
    .op('invoke-direct', m(INTENT, '<init>', 'V', CONTEXT, 'Ljava/lang/Class;'), 0, 5, 1)
    .op('invoke-virtual', m(ACTIVITY, 'startActivity', 'V', INTENT), 5, 0)
    .op('invoke-virtual', m(ACTIVITY, 'finish', 'V'), 5)
    .op('new-instance', 0, dex.type(HANDLER)).op('invoke-static', m(LOOPER, 'getMainLooper', LOOPER)).op('move-result-object', 1)
    .op('invoke-direct', m(HANDLER, '<init>', 'V', LOOPER), 0, 1)
    .op('new-instance', 2, dex.type(SCREEN_RESTART_CLASS)).op('invoke-direct', m(SCREEN_RESTART_CLASS, '<init>', 'V'), 2)
    .op('const-wide/16', 3, KILL_DELAY_MS)
    .op('invoke-virtual', m(HANDLER, 'postDelayed', 'Z', RUNNABLE, 'J'), 0, 2, 3, 4)
    .op('return-void');
  const run = new CodeBuilder({ registers: 2, outs: 1 })
    .op('invoke-static', m(PROCESS, 'myPid', 'I')).op('move-result', 0)
    .op('invoke-static', m(PROCESS, 'killProcess', 'V', 'I'), 0).op('return-void');
  cls.addMethod({ name: '<init>', returnType: 'V', params: [], access: ACC.PUBLIC | ACC.CONSTRUCTOR, code: init });
  cls.addMethod({ name: 'size', returnType: 'I', params: [ACTIVITY], access: ACC.PRIVATE | ACC.STATIC, code: size });
  cls.addMethod({ name: 'start', returnType: 'V', params: [ACTIVITY], access: ACC.PUBLIC | ACC.STATIC, code: start });
  cls.addMethod({ name: 'changed', returnType: 'V', params: [ACTIVITY, CONFIG], access: ACC.PUBLIC | ACC.STATIC, code: changed });
  cls.addMethod({ name: 'restart', returnType: 'V', params: [ACTIVITY], access: ACC.PRIVATE | ACC.STATIC, code: restart });
  cls.addMethod({ name: 'run', returnType: 'V', params: [], access: ACC.PUBLIC, code: run });

  const act = dex.addClass({ descriptor: RESTART_ACTIVITY_CLASS, access: ACC.PUBLIC | ACC.FINAL, superclass: ACTIVITY, interfaces: [RUNNABLE], sourceFile: 'RestartActivity.java' });
  const actInit = new CodeBuilder({ registers: 1, outs: 1 }).op('invoke-direct', m(ACTIVITY, '<init>', 'V'), 0).op('return-void');
  // v3 = this, v4 = saved state; v0 handler, v1+v2 delay
  const onCreate = new CodeBuilder({ registers: 5, outs: 4 })
    .op('invoke-super', m(ACTIVITY, 'onCreate', 'V', BUNDLE), 3, 4)
    .op('new-instance', 0, dex.type(HANDLER)).op('invoke-direct', m(HANDLER, '<init>', 'V'), 0)
    .op('const-wide/16', 1, RELAUNCH_DELAY_MS)
    .op('invoke-virtual', m(HANDLER, 'postDelayed', 'Z', RUNNABLE, 'J'), 0, 3, 1, 2)
    .op('return-void');
  // v3 = this; v0 package manager / launch intent, v1 package name / flags
  const actRun = new CodeBuilder({ registers: 4, outs: 2 })
    .op('invoke-virtual', m(ACTIVITY, 'getPackageManager', PM), 3).op('move-result-object', 0)
    .op('invoke-virtual', m(ACTIVITY, 'getPackageName', STR), 3).op('move-result-object', 1)
    .op('invoke-virtual', m(PM, 'getLaunchIntentForPackage', INTENT, STR), 0, 1).op('move-result-object', 0)
    .op('if-eqz', 0, 'fin')
    .op('const', 1, 0x10008000) // FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK
    .op('invoke-virtual', m(INTENT, 'addFlags', INTENT, 'I'), 0, 1)
    .op('invoke-virtual', m(ACTIVITY, 'startActivity', 'V', INTENT), 3, 0)
    .label('fin')
    .op('invoke-virtual', m(ACTIVITY, 'finish', 'V'), 3)
    .op('invoke-static', m(PROCESS, 'myPid', 'I')).op('move-result', 0)
    .op('invoke-static', m(PROCESS, 'killProcess', 'V', 'I'), 0).op('return-void');
  act.addMethod({ name: '<init>', returnType: 'V', params: [], access: ACC.PUBLIC | ACC.CONSTRUCTOR, code: actInit });
  act.addMethod({ name: 'onCreate', returnType: 'V', params: [BUNDLE], access: ACC.PROTECTED, code: onCreate });
  act.addMethod({ name: 'run', returnType: 'V', params: [], access: ACC.PUBLIC, code: actRun });
}

/** [method, params, helper, helper arguments (this, then the configuration where taken)]. */
const HOOKS: [string, string[], string, number][] = [
  ['onCreate', [BUNDLE], 'start', 1],
  ['onConfigurationChanged', [CONFIG], 'changed', 2],
];
interface Hook { method: MethodInfo; helper: string; count: number; hooked: boolean }

function state(set: DexSet): { dex: DexFile; cls: DexClass; hooks: Hook[]; hasHelper: boolean } | undefined {
  const hit = set.findClass(ACTIVITY_CLASS);
  if (!hit) return undefined;
  const hooks: Hook[] = [];
  for (const [name, params, helper, count] of HOOKS) {
    const method = hit.cls.findMethod(name, params, 'V');
    if (!method?.hasCode) return undefined;
    hooks.push({ method, helper, count, hooked: callsClass(hit.dex, hit.cls, method, SCREEN_RESTART_CLASS) });
  }
  return { ...hit, hooks, hasHelper: !!set.findClass(SCREEN_RESTART_CLASS) && !!set.findClass(RESTART_ACTIVITY_CLASS) };
}

function detect(ctx: PatchContext): PatchStatus {
  const set = openDexSet(ctx);
  const s = set && state(set);
  if (!s || !findApplication(ctx)) return 'incompatible';
  return s.hasHelper && s.hooks.every((h) => h.hooked) && findActivityByName(ctx, RESTART_ACTIVITY_NAME) ? 'applied' : 'notApplied';
}

/**
 * The game picks its content size and its phone / tablet layout once, when it starts. A foldable that is unfolded while
 * the game runs hands the game a window several times larger; the game keeps its old size and Android stretches the
 * picture. This patch restarts the game (it pauses and saves first) when the physical display crosses the 600 dp
 * tablet threshold in either direction, so it starts again as if opened on the new screen. Pair with `tablet-layout`
 * to get the tablet interface on the unfolded screen.
 */
export const restartOnResize: Patch = {
  id: 'restart-on-resize',
  version: 1,
  nameKey: 'patch.restart-on-resize.name',
  descriptionKey: 'patch.restart-on-resize.description',
  appliesTo: { packageName: BLOCKHEADS_PACKAGE },
  optIn: true,
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`restart-on-resize cannot be applied (status: ${status})`, 'cannotApply', { status });
    const set = openDexSet(ctx)!;
    const s = state(set)!;
    const missing = s.hooks.filter((h) => !h.hooked);
    editDex('restart-on-resize', () => {
      if (!s.hasHelper) addHelper(s.dex);
      for (const h of missing) {
        const target = s.dex.method(SCREEN_RESTART_CLASS, h.helper, 'V', h.count === 1 ? [ACTIVITY] : [ACTIVITY, CONFIG]);
        s.cls.prependCode(h.method, (registers, ins) => new CodeBuilder({ registers, outs: h.count }).op('invoke-static/range', target, registers - ins, h.count));
      }
      set.commit();
    });
    if (!findActivityByName(ctx, RESTART_ACTIVITY_NAME)) {
      const app = findApplication(ctx)!;
      insertElement(ctx.manifest, app, {
        name: 'activity',
        attributes: [
          { name: 'theme', nsUri: ANDROID_NS, resourceId: ID.theme, valueType: ValueType.Reference, data: THEME_TRANSLUCENT },
          { name: 'name', nsUri: ANDROID_NS, resourceId: ID.name, value: RESTART_ACTIVITY_NAME },
          { name: 'exported', nsUri: ANDROID_NS, resourceId: ID.exported, valueType: ValueType.IntBoolean, data: 0 },
          { name: 'process', nsUri: ANDROID_NS, resourceId: ID.process, value: ':restart' },
          { name: 'excludeFromRecents', nsUri: ANDROID_NS, resourceId: ID.excludeFromRecents, valueType: ValueType.IntBoolean, data: 0xffffffff },
        ],
      });
      ctx.markManifestDirty();
    }
    ctx.log('restart-on-resize: VerdeActivity hooks + RestartActivity (:restart)');
  },
};
