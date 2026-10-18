import { ANDROID_NS, ValueType, addAttr, findElements, getAttr, setAttrValue, type AxmlElement } from '../axml';
import { PatchError, type Patch, type PatchContext, type PatchCredits, type PatchStatus } from './types';

export const ANDROID_THEME_ATTR_ID = 0x01010000;
const ANDROID_NAME_ATTR_ID = 0x01010003;
/** @android:style/Theme.Translucent.NoTitleBar.Fullscreen */
export const THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN = 0x01030011;

export interface TranslucentActivitySpec {
  id: string;
  /** Fully qualified class name of the activity to make translucent. */
  activity: string;
  credits?: PatchCredits;
  optIn?: boolean;
  /** Log line written after applying. */
  logMessage: string;
}

function findActivity(ctx: PatchContext, activity: string): AxmlElement | undefined {
  const pkg = ctx.info.packageName;
  return findElements(ctx.manifest, (e, path) => e.name === 'activity' && path.join('/') === 'manifest/application/activity').find((e) => {
    const n = getAttr(e, 'name', ANDROID_NS, ANDROID_NAME_ATTR_ID)?.stringValue;
    if (!n) return false;
    if (n === activity) return true;
    if (n.startsWith('.')) return pkg + n === activity;
    return false;
  });
}

/**
 * Builds a patch that gives one activity a translucent theme. An opaque activity on top makes Android stop the
 * game activity (destroying its surface); a translucent one keeps it only paused.
 */
export function makeTranslucentActivityPatch(spec: TranslucentActivitySpec): Patch {
  const detect = (ctx: PatchContext): PatchStatus => {
    const el = findActivity(ctx, spec.activity);
    if (!el) return 'incompatible';
    const theme = getAttr(el, 'theme', ANDROID_NS, ANDROID_THEME_ATTR_ID);
    if (theme && theme.valueType === ValueType.Reference && theme.data === THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN) return 'applied';
    return 'notApplied';
  };
  return {
    id: spec.id,
    version: 1,
    nameKey: `patch.${spec.id}.name`,
    descriptionKey: `patch.${spec.id}.description`,
    appliesTo: { packageName: 'com.noodlecake.blockheads' },
    ...(spec.credits ? { credits: spec.credits } : {}),
    ...(spec.optIn ? { optIn: true } : {}),
    detect,
    apply(ctx) {
      const status = detect(ctx);
      if (status !== 'notApplied') throw new PatchError(`${spec.id} cannot be applied (status: ${status})`, 'cannotApply', { status });
      const el = findActivity(ctx, spec.activity)!;
      const theme = getAttr(el, 'theme', ANDROID_NS, ANDROID_THEME_ATTR_ID);
      if (theme) setAttrValue(ctx.manifest, theme, ValueType.Reference, THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN);
      else
        addAttr(ctx.manifest, el, {
          nsUri: ANDROID_NS, name: 'theme', resourceId: ANDROID_THEME_ATTR_ID, rawValue: null,
          valueType: ValueType.Reference, data: THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN,
        });
      ctx.markManifestDirty();
      ctx.log(spec.logMessage);
    },
  };
}
