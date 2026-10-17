import { ANDROID_NS, ValueType, addAttr, findElements, getAttr, setAttrValue, type AxmlElement } from '../axml';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const ANDROID_THEME_ATTR_ID = 0x01010000;
const ANDROID_NAME_ATTR_ID = 0x01010003;
/** @android:style/Theme.Translucent.NoTitleBar.Fullscreen */
export const THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN = 0x01030011;

const ACTIVITY = 'com.noodlecake.noodlewebview.BlockheadsWebView';

function findActivity(ctx: PatchContext): AxmlElement | undefined {
  const pkg = ctx.info.packageName;
  return findElements(ctx.manifest, (e, path) => e.name === 'activity' && path.join('/') === 'manifest/application/activity').find((e) => {
    const n = getAttr(e, 'name', ANDROID_NS, ANDROID_NAME_ATTR_ID)?.stringValue;
    if (!n) return false;
    if (n === ACTIVITY) return true;
    if (n.startsWith('.')) return pkg + n === ACTIVITY;
    return false;
  });
}

function detect(ctx: PatchContext): PatchStatus {
  const el = findActivity(ctx);
  if (!el) return 'incompatible';
  const theme = getAttr(el, 'theme', ANDROID_NS, ANDROID_THEME_ATTR_ID);
  if (theme && theme.valueType === ValueType.Reference && theme.data === THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN) return 'applied';
  return 'notApplied';
}

/**
 * The welcome popup activity is opaque, so Android stops the game activity, which deadlocks the game's
 * render thread against the main thread. A translucent theme keeps the game activity only paused.
 */
export const fixWelcomePopupDeadlock: Patch = {
  id: 'fix-welcome-popup-deadlock',
  version: 1,
  nameKey: 'patch.fix-welcome-popup-deadlock.name',
  descriptionKey: 'patch.fix-welcome-popup-deadlock.description',
  appliesTo: { packageName: 'com.noodlecake.blockheads' },
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`fix-welcome-popup-deadlock cannot be applied (status: ${status})`, 'cannotApply', { status });
    const el = findActivity(ctx)!;
    const theme = getAttr(el, 'theme', ANDROID_NS, ANDROID_THEME_ATTR_ID);
    if (theme) setAttrValue(ctx.manifest, theme, ValueType.Reference, THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN);
    else
      addAttr(ctx.manifest, el, {
        nsUri: ANDROID_NS, name: 'theme', resourceId: ANDROID_THEME_ATTR_ID, rawValue: null,
        valueType: ValueType.Reference, data: THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN,
      });
    ctx.markManifestDirty();
    ctx.log('BlockheadsWebView theme set to Theme.Translucent.NoTitleBar.Fullscreen');
  },
};
