import { ACC, CodeBuilder, type DexClass, type DexFile, type DexSet, type MethodInfo } from '../dex';
import { JARLPENGUIN_CREDITS } from './credits';
import { callsClass, calleeOf, editDex, insnsOf, openDexSet } from './dex-support';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const TABLET_CLASS = 'Lcom/blockheadsclub/patch/TabletMode;';
/** Smallest width (dp) from which a device counts as a tablet (Android's own `sw600dp` qualifier). */
export const TABLET_MIN_DP = 600;
/** Long side (px) from which the @2x iPad splash is used. */
export const SPLASH_2X_PX = 1536;
const MANAGER = 'Lcom/apportable/LibraryManager;', LOADER = 'Lcom/apportable/LibraryLoader;', SPLASH = 'Lcom/apportable/app/SplashScreen;';
const STR = 'Ljava/lang/String;', STREAM = 'Ljava/io/InputStream;', CONTEXT = 'Landroid/content/Context;', ASSETS = 'Landroid/content/res/AssetManager;';
const RES = 'Landroid/content/res/Resources;', CONFIG = 'Landroid/content/res/Configuration;', METRICS = 'Landroid/util/DisplayMetrics;';

/**
 * Adds `TabletMode`:
 * `init()` sets the environment variable TABLET=yes (read once by the game's UIDevice idiom check) when the smallest screen
 * width is at least 600 dp, then calls the native `LibraryLoader.init()` it replaces;
 * `splash()` opens the portrait iPad splash image on tablets, or returns null so the game's own list is used.
 */
function addHelper(dex: DexFile): void {
  const m = (cls: string, name: string, ret: string, ...params: string[]): number => dex.method(cls, name, ret, params);
  const cls = dex.addClass({ descriptor: TABLET_CLASS, sourceFile: 'TabletMode.java' });
  const throwable = dex.type('Ljava/lang/Throwable;');
  const smallest = dex.field(CONFIG, 'smallestScreenWidthDp', 'I');
  const init = new CodeBuilder({ registers: 3, outs: 2 })
    .label('try')
    .op('invoke-static', m(RES, 'getSystem', RES)).op('move-result-object', 0)
    .op('invoke-virtual', m(RES, 'getConfiguration', CONFIG), 0).op('move-result-object', 0)
    .op('iget', 0, 0, smallest).op('const/16', 1, TABLET_MIN_DP).op('if-lt', 0, 1, 'end')
    .op('const-string', 0, dex.string('TABLET')).op('const-string', 1, dex.string('yes'))
    .op('invoke-static', m(LOADER, 'setenv', 'V', STR, STR), 0, 1)
    .label('end')
    .op('invoke-static', m(LOADER, 'init', 'V')).op('return-void')
    .label('catch').op('move-exception', 0).op('goto', 'end')
    .tryCatch({ start: 'try', end: 'end', handlers: [{ type: throwable, label: 'catch' }] });
  const splash = new CodeBuilder({ registers: 4, outs: 2 })
    .label('try')
    .op('invoke-static', m(RES, 'getSystem', RES)).op('move-result-object', 0)
    .op('invoke-virtual', m(RES, 'getConfiguration', CONFIG), 0).op('move-result-object', 1)
    .op('iget', 1, 1, smallest).op('const/16', 2, TABLET_MIN_DP).op('if-lt', 1, 2, 'none')
    .op('invoke-virtual', m(RES, 'getDisplayMetrics', METRICS), 0).op('move-result-object', 0)
    .op('iget', 1, 0, dex.field(METRICS, 'widthPixels', 'I')).op('iget', 0, 0, dex.field(METRICS, 'heightPixels', 'I'))
    .op('invoke-static', m('Ljava/lang/Math;', 'max', 'I', 'I', 'I'), 1, 0).op('move-result', 0)
    .op('const/16', 1, SPLASH_2X_PX).op('const-string', 2, dex.string('Default-Portrait~ipad.png')).op('if-lt', 0, 1, 'open')
    .op('const-string', 2, dex.string('Default-Portrait@2x~ipad.png'))
    .label('open')
    .op('invoke-static', m('Lcom/apportable/app/VerdeApplication;', 'getApplication', 'Lcom/apportable/app/VerdeApplication;')).op('move-result-object', 0)
    .op('invoke-virtual', m(CONTEXT, 'getAssets', ASSETS), 0).op('move-result-object', 0)
    .op('invoke-virtual', m(ASSETS, 'open', STREAM, STR), 0, 2).op('move-result-object', 0)
    .op('return-object', 0)
    .label('none')
    .op('const/4', 0, 0).op('return-object', 0)
    .label('end')
    .label('catch').op('move-exception', 0).op('const/4', 0, 0).op('return-object', 0)
    .tryCatch({ start: 'try', end: 'end', handlers: [{ type: throwable, label: 'catch' }] });
  cls.addMethod({ name: 'init', returnType: 'V', params: [], access: ACC.PUBLIC | ACC.STATIC, code: init });
  cls.addMethod({ name: 'splash', returnType: STREAM, params: [], access: ACC.PUBLIC | ACC.STATIC, code: splash });
}

interface Sites {
  set: DexSet;
  init: { dex: DexFile; cls: DexClass; method: MethodInfo; at: number | undefined };
  splash: { dex: DexFile; cls: DexClass; method: MethodInfo; hooked: boolean };
}

function locate(ctx: PatchContext): Sites | undefined {
  const set = openDexSet(ctx);
  const mgr = set?.findClass(MANAGER), spl = set?.findClass(SPLASH);
  const initM = mgr?.cls.findMethod('initializeLibv', [], 'V'), splM = spl?.cls.findMethod('getSplashScreen', [], STREAM);
  if (!set || !mgr || !spl || !initM?.hasCode || !splM?.hasCode || !(splM.access & ACC.STATIC)) return undefined;
  const calls = insnsOf(mgr.cls, initM).filter((i) => {
    const c = calleeOf(mgr.dex, i);
    return i.name === 'invoke-static' && c?.cls === LOADER && c.name === 'init' && c.params.length === 0 && c.ret === 'V';
  });
  const hooked = callsClass(mgr.dex, mgr.cls, initM, TABLET_CLASS);
  if (!hooked && calls.length !== 1) return undefined;
  return {
    set,
    init: { dex: mgr.dex, cls: mgr.cls, method: initM, at: hooked ? undefined : calls[0]!.at },
    splash: { dex: spl.dex, cls: spl.cls, method: splM, hooked: callsClass(spl.dex, spl.cls, splM, TABLET_CLASS) },
  };
}

function detect(ctx: PatchContext): PatchStatus {
  const s = locate(ctx);
  if (!s) return 'incompatible';
  return s.init.at === undefined && s.splash.hooked ? 'applied' : 'notApplied';
}

/**
 * EXPERIMENTAL. Makes the game use its iPad idiom and iPad splash screen on tablets (smallest width >= 600 dp).
 * The idiom is read once from the environment variable TABLET; the game's Java start-up code exports every manifest
 * meta-data entry as an environment variable but nothing sets TABLET, so the call that hands over to the native library is
 * redirected to a helper that sets it first. The photo picker, share and instructions code use UIPopoverController on iPad
 * and Apportable implements almost none of it, so those buttons may crash or do nothing on tablets: hence opt-in.
 */
export const tabletLayout: Patch = {
  id: 'tablet-layout',
  version: 1,
  nameKey: 'patch.tablet-layout.name',
  descriptionKey: 'patch.tablet-layout.description',
  appliesTo: { packageName: 'com.noodlecake.blockheads', versionNames: ['1.7.4', '1.7.5', '1.7.6'] },
  credits: JARLPENGUIN_CREDITS,
  optIn: true,
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`tablet-layout cannot be applied (status: ${status})`, 'cannotApply', { status });
    const { set, init, splash } = locate(ctx)!;
    editDex('tablet-layout', () => {
      if (!set.findClass(TABLET_CLASS)) addHelper(init.dex);
      if (init.at !== undefined) {
        const at = init.at;
        const target = init.dex.method(TABLET_CLASS, 'init', 'V', []);
        init.cls.patchInsns(init.method, (u) => { u[at + 1] = target; });
      }
      if (!splash.hooked) {
        const target = splash.dex.method(TABLET_CLASS, 'splash', STREAM, []);
        splash.cls.prependCode(splash.method, (registers) =>
          new CodeBuilder({ registers, outs: 1 })
            .op('invoke-static', target).op('move-result-object', 0).op('if-eqz', 0, 'continue').op('return-object', 0).label('continue'));
      }
      set.commit();
    });
    ctx.log('tablet-layout: TABLET=yes on tablets, iPad splash (experimental)');
  },
};
