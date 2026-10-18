import { ANDROID_NS, findElementsByName, insertElement } from '../axml';
import { ACC, CodeBuilder, type DexFile, type DexSet } from '../dex';
import { JARLPENGUIN_CREDITS } from './credits';
import { callsClass, editDex, openDexSet } from './dex-support';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const MULTICAST_CLASS = 'Lcom/blockheadsclub/patch/MulticastHold;';
export const MULTICAST_PERMISSION = 'android.permission.CHANGE_WIFI_MULTICAST_STATE';
const ACTIVITY_CLASS = 'Lcom/apportable/activity/VerdeActivity;';
const ID_NAME = 0x01010003;
const ACTIVITY = 'Landroid/app/Activity;', CONTEXT = 'Landroid/content/Context;', OBJ = 'Ljava/lang/Object;', STR = 'Ljava/lang/String;';
const WIFI = 'Landroid/net/wifi/WifiManager;', LOCK = 'Landroid/net/wifi/WifiManager$MulticastLock;';

/** [hooked method, helper to call first]: the lock is held from onResume until onPause / onDestroy. */
const HOOKS = [['onResume', 'acquire'], ['onPause', 'release'], ['onDestroy', 'release']] as const;

/**
 * Adds `MulticastHold` with `acquire(Activity)` and `release()`. The lock is created once (not reference counted) and
 * kept in a static field. Nothing here may throw into the game, so both methods swallow every Throwable (for example a
 * SecurityException when the permission is missing).
 */
function addHelper(dex: DexFile): void {
  const m = (cls: string, name: string, ret: string, ...params: string[]): number => dex.method(cls, name, ret, params);
  const cls = dex.addClass({ descriptor: MULTICAST_CLASS, sourceFile: 'MulticastHold.java' });
  const lock = cls.addStaticField('lock', LOCK, ACC.PRIVATE);
  const throwable = dex.type('Ljava/lang/Throwable;');
  // v0 lock, v1/v2 temps, v4 = activity
  const acquire = new CodeBuilder({ registers: 5, outs: 2 })
    .label('try')
    .op('sget-object', 0, lock).op('if-nez', 0, 'have')
    .op('invoke-virtual', m(CONTEXT, 'getApplicationContext', CONTEXT), 4).op('move-result-object', 1)
    .op('const-string', 2, dex.string('wifi'))
    .op('invoke-virtual', m(CONTEXT, 'getSystemService', OBJ, STR), 1, 2).op('move-result-object', 1)
    .op('instance-of', 2, 1, dex.type(WIFI)).op('if-eqz', 2, 'end')
    .op('check-cast', 1, dex.type(WIFI))
    .op('const-string', 2, dex.string('blockheads-mdns'))
    .op('invoke-virtual', m(WIFI, 'createMulticastLock', LOCK, STR), 1, 2).op('move-result-object', 0).op('if-eqz', 0, 'end')
    .op('const/4', 1, 0)
    .op('invoke-virtual', m(LOCK, 'setReferenceCounted', 'V', 'Z'), 0, 1)
    .op('sput-object', 0, lock)
    .label('have')
    .op('invoke-virtual', m(LOCK, 'isHeld', 'Z'), 0).op('move-result', 1).op('if-nez', 1, 'end')
    .op('invoke-virtual', m(LOCK, 'acquire', 'V'), 0)
    .label('end')
    .label('done')
    .op('return-void')
    .label('catch').op('move-exception', 0).op('goto', 'done')
    .tryCatch({ start: 'try', end: 'end', handlers: [{ type: throwable, label: 'catch' }] });
  const release = new CodeBuilder({ registers: 2, outs: 1 })
    .label('try')
    .op('sget-object', 0, lock).op('if-eqz', 0, 'end')
    .op('invoke-virtual', m(LOCK, 'isHeld', 'Z'), 0).op('move-result', 1).op('if-eqz', 1, 'end')
    .op('invoke-virtual', m(LOCK, 'release', 'V'), 0)
    .label('end')
    .label('done')
    .op('return-void')
    .label('catch').op('move-exception', 0).op('goto', 'done')
    .tryCatch({ start: 'try', end: 'end', handlers: [{ type: throwable, label: 'catch' }] });
  cls.addMethod({ name: 'acquire', returnType: 'V', params: [ACTIVITY], access: ACC.PUBLIC | ACC.STATIC, code: acquire });
  cls.addMethod({ name: 'release', returnType: 'V', params: [], access: ACC.PUBLIC | ACC.STATIC, code: release });
}

function hookState(set: DexSet): { dex: DexFile; missing: (typeof HOOKS)[number][] } | undefined {
  const hit = set.findClass(ACTIVITY_CLASS);
  if (!hit) return undefined;
  const methods = HOOKS.map((h) => hit.cls.findMethod(h[0], [], 'V'));
  if (methods.some((x) => !x?.hasCode)) return undefined;
  return { dex: hit.dex, missing: HOOKS.filter((_, i) => !callsClass(hit.dex, hit.cls, methods[i]!, MULTICAST_CLASS)) };
}

const hasPermission = (ctx: PatchContext): boolean => findElementsByName(ctx.manifest, 'uses-permission', MULTICAST_PERMISSION).length > 0;

function detect(ctx: PatchContext): PatchStatus {
  const set = openDexSet(ctx);
  const state = set && hookState(set);
  if (!state || ctx.manifest.root.name !== 'manifest') return 'incompatible';
  return state.missing.length === 0 && hasPermission(ctx) ? 'applied' : 'notApplied';
}

/**
 * mDNS (the game's local-network hosting and discovery) needs inbound multicast, which most Wi-Fi drivers drop unless an
 * app holds a `WifiManager.MulticastLock`. Adds the normal permission `CHANGE_WIFI_MULTICAST_STATE` and holds the lock
 * while the game activity is resumed. Device test: host a LOCAL NETWORK world on one device and join it from another
 * device on the same Wi-Fi; `dumpsys wifi | grep -i multicast` must list the lock while the game is in the foreground.
 */
export const lanMulticast: Patch = {
  id: 'lan-multicast',
  version: 1,
  nameKey: 'patch.lan-multicast.name',
  descriptionKey: 'patch.lan-multicast.description',
  appliesTo: { packageName: 'com.noodlecake.blockheads', versionNames: ['1.7.4', '1.7.5', '1.7.6'] },
  credits: JARLPENGUIN_CREDITS,
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`lan-multicast cannot be applied (status: ${status})`, 'cannotApply', { status });
    if (!hasPermission(ctx)) {
      const root = ctx.manifest.root;
      const last = root.children.map((c, i) => (c.name === 'uses-permission' ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
      insertElement(ctx.manifest, root, { name: 'uses-permission', attributes: [{ name: 'name', nsUri: ANDROID_NS, resourceId: ID_NAME, value: MULTICAST_PERMISSION }] }, last + 1);
      ctx.markManifestDirty();
    }
    const set = openDexSet(ctx)!;
    const { dex, missing } = hookState(set)!;
    editDex('lan-multicast', () => {
      if (!set.findClass(MULTICAST_CLASS)) addHelper(dex);
      const cls = dex.findClass(ACTIVITY_CLASS)!;
      for (const [name, helper] of missing) {
        const target = helper === 'acquire' ? dex.method(MULTICAST_CLASS, 'acquire', 'V', [ACTIVITY]) : dex.method(MULTICAST_CLASS, 'release', 'V', []);
        cls.prependCode(cls.findMethod(name, [], 'V')!, (registers, ins) => {
          const b = new CodeBuilder({ registers, outs: 1 });
          return helper === 'acquire' ? b.op('invoke-static/range', target, registers - ins, 1) : b.op('invoke-static', target);
        });
      }
      set.commit();
    });
    ctx.log(`lan-multicast: permission and multicast lock hooks (${missing.map((x) => x[0]).join(', ')})`);
  },
};
