import { ACC, CodeBuilder, type DexClass, type DexFile } from '../dex';
import { JARLPENGUIN_CREDITS } from './credits';
import { editDex, openDexSet } from './dex-support';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const GUARD_CLASS = 'Lcom/blockheadsclub/patch/WebViewGuard;';
const CLIENT = 'Landroid/webkit/WebViewClient;';
const WEBVIEW = 'Landroid/webkit/WebView;';
const DETAIL = 'Landroid/webkit/RenderProcessGoneDetail;';
const GAME_WEB_ACTIVITY = 'com.noodlecake.noodlewebview.BlockheadsWebView';

const OBJ = 'Ljava/lang/Object;', STR = 'Ljava/lang/String;', ACTIVITY = 'Landroid/app/Activity;', VIEWGROUP = 'Landroid/view/ViewGroup;';

/**
 * Adds `WebViewGuard.handle(WebView)`: detaches the dead web view from its parent, destroys it and, when it
 * lives in the game's own web-view activity, finishes that activity. Never throws; always returns true.
 */
function addGuard(dex: DexFile): void {
  const m = (cls: string, name: string, ret: string, ...params: string[]): number => dex.method(cls, name, ret, params);
  const b = new CodeBuilder({ registers: 5, outs: 2 });
  // v0 result, v1 parent / context, v2 temp, v3 temp, v4 = view
  b.op('const/4', 0, 1).op('if-eqz', 4, 'end')
    .label('try')
    .op('invoke-virtual', m(WEBVIEW, 'getParent', 'Landroid/view/ViewParent;'), 4).op('move-result-object', 1)
    .op('instance-of', 2, 1, dex.type(VIEWGROUP)).op('if-eqz', 2, 'detached')
    .op('check-cast', 1, dex.type(VIEWGROUP))
    .op('invoke-virtual', m(VIEWGROUP, 'removeView', 'V', 'Landroid/view/View;'), 1, 4)
    .label('detached')
    .op('invoke-virtual', m(WEBVIEW, 'destroy', 'V'), 4)
    .op('invoke-virtual', m(WEBVIEW, 'getContext', 'Landroid/content/Context;'), 4).op('move-result-object', 1)
    .op('instance-of', 2, 1, dex.type(ACTIVITY)).op('if-eqz', 2, 'done')
    .op('invoke-virtual', m(OBJ, 'getClass', 'Ljava/lang/Class;'), 1).op('move-result-object', 2)
    .op('invoke-virtual', m('Ljava/lang/Class;', 'getName', STR), 2).op('move-result-object', 2)
    .op('const-string', 3, dex.string(GAME_WEB_ACTIVITY))
    .op('invoke-virtual', m(STR, 'equals', 'Z', OBJ), 3, 2).op('move-result', 2).op('if-eqz', 2, 'done')
    .op('check-cast', 1, dex.type(ACTIVITY))
    .op('invoke-virtual', m(ACTIVITY, 'finish', 'V'), 1)
    .label('done')
    .label('end')
    .op('return', 0)
    .label('catch').op('move-exception', 1).op('goto', 'end')
    .tryCatch({ start: 'try', end: 'done', handlers: [{ type: dex.type('Ljava/lang/Throwable;'), label: 'catch' }] });
  const cls = dex.addClass({ descriptor: GUARD_CLASS, sourceFile: 'WebViewGuard.java' });
  cls.addMethod({ name: 'handle', returnType: 'Z', params: [WEBVIEW], access: ACC.PUBLIC | ACC.STATIC, code: b });
}

function addHandler(dex: DexFile, cls: DexClass): void {
  const guard = dex.method(GUARD_CLASS, 'handle', 'Z', [WEBVIEW]);
  const b = new CodeBuilder({ registers: 4, outs: 1 })
    .op('invoke-static', guard, 2).op('move-result', 0).op('return', 0);
  cls.addMethod({ name: 'onRenderProcessGone', returnType: 'Z', params: [WEBVIEW, DETAIL], access: ACC.PUBLIC, code: b });
}

const lacking = (ctx: PatchContext) => {
  const set = openDexSet(ctx);
  if (!set) return undefined;
  const clients = set.subclassesOf(CLIENT);
  return { set, clients, missing: clients.filter((c) => !c.cls.findMethod('onRenderProcessGone', [WEBVIEW, DETAIL], 'Z')) };
};

function detect(ctx: PatchContext): PatchStatus {
  const l = lacking(ctx);
  if (!l || !l.clients.length) return 'incompatible';
  return l.missing.length ? 'notApplied' : 'applied';
}

/**
 * Without an `onRenderProcessGone` override, Android kills the whole app when the WebView renderer process dies
 * (crash or low-memory kill). Every direct WebViewClient subclass (the game's own and the bundled ad SDKs') gets
 * an override that cleans the dead view up and returns true, which tells Android the app survives.
 */
export const fixWebviewCrash: Patch = {
  id: 'fix-webview-crash',
  version: 1,
  nameKey: 'patch.fix-webview-crash.name',
  descriptionKey: 'patch.fix-webview-crash.description',
  appliesTo: { packageName: 'com.noodlecake.blockheads' },
  credits: JARLPENGUIN_CREDITS,
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`fix-webview-crash cannot be applied (status: ${status})`, 'cannotApply', { status });
    const { set, missing } = lacking(ctx)!;
    editDex('fix-webview-crash', () => {
      if (!set.findClass(GUARD_CLASS)) addGuard(set.get(set.names[0]!));
      for (const t of missing) addHandler(t.dex, t.cls);
      set.commit();
    });
    ctx.log(`WebViewClient: added onRenderProcessGone to ${missing.length} classes`);
  },
};
