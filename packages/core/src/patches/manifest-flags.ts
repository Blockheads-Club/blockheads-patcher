import { ANDROID_NS, ValueType, addAttr, findElements, getAttr, setAttrValue, type AxmlElement } from '../axml';
import { PatchError, type Patch, type PatchContext, type PatchCredits, type PatchStatus } from './types';

export const BLOCKHEADS_PACKAGE = 'com.noodlecake.blockheads';
export const MAIN_ACTIVITY = 'com.apportable.activity.VerdeActivity';
const ANDROID_NAME_ATTR_ID = 0x01010003;

/** Platform attribute ids (android.R.attr). */
export const ATTR = {
  usesCleartextTraffic: 0x010104ec,
  resizeableActivity: 0x010104f6,
  hasFragileUserData: 0x0101059a,
  allowAudioPlaybackCapture: 0x01010601,
  requestLegacyExternalStorage: 0x01010603,
} as const;

export function findApplication(ctx: PatchContext): AxmlElement | undefined {
  return findElements(ctx.manifest, (e, path) => e.name === 'application' && path.join('/') === 'manifest/application')[0];
}

/** Finds a top-level activity by its fully qualified class name (relative `.Name` entries are resolved against the package). */
export function findActivityByName(ctx: PatchContext, className: string): AxmlElement | undefined {
  const pkg = ctx.info.packageName;
  return findElements(ctx.manifest, (e, path) => e.name === 'activity' && path.join('/') === 'manifest/application/activity').find((e) => {
    const n = getAttr(e, 'name', ANDROID_NS, ANDROID_NAME_ATTR_ID)?.stringValue;
    return n === className || (n !== undefined && n.startsWith('.') && pkg + n === className);
  });
}

export function readBool(el: AxmlElement, name: string, id: number): boolean | undefined {
  const a = getAttr(el, name, ANDROID_NS, id);
  return a && a.valueType === ValueType.IntBoolean ? a.data !== 0 : undefined;
}

/** Sets a boolean android: attribute, replacing any existing value of another type. */
export function writeBool(ctx: PatchContext, el: AxmlElement, name: string, id: number, value: boolean): void {
  const data = value ? 0xffffffff : 0;
  const a = getAttr(el, name, ANDROID_NS, id);
  if (a) setAttrValue(ctx.manifest, a, ValueType.IntBoolean, data);
  else addAttr(ctx.manifest, el, { nsUri: ANDROID_NS, name, resourceId: id, rawValue: null, valueType: ValueType.IntBoolean, data });
}

export interface BooleanFlagSpec {
  id: string;
  /** `application` or the class name of an activity. */
  target: 'application' | { activity: string };
  attrName: string;
  attrId: number;
  /** Value written; the patch is `applied` once the attribute has it. */
  value: boolean;
  credits?: PatchCredits;
  optIn?: boolean;
}

/** Builds a patch that sets one boolean attribute on `<application>` or on one activity. */
export function makeBooleanFlagPatch(spec: BooleanFlagSpec): Patch {
  const locate = (ctx: PatchContext): AxmlElement | undefined =>
    spec.target === 'application' ? findApplication(ctx) : findActivityByName(ctx, spec.target.activity);
  const detect = (ctx: PatchContext): PatchStatus => {
    const el = locate(ctx);
    if (!el) return 'incompatible';
    return readBool(el, spec.attrName, spec.attrId) === spec.value ? 'applied' : 'notApplied';
  };
  const patch: Patch = {
    id: spec.id,
    version: 1,
    nameKey: `patch.${spec.id}.name`,
    descriptionKey: `patch.${spec.id}.description`,
    appliesTo: { packageName: BLOCKHEADS_PACKAGE },
    detect,
    apply(ctx) {
      const status = detect(ctx);
      if (status !== 'notApplied') throw new PatchError(`${spec.id} cannot be applied (status: ${status})`, 'cannotApply', { status });
      writeBool(ctx, locate(ctx)!, spec.attrName, spec.attrId, spec.value);
      ctx.markManifestDirty();
      ctx.log(`${spec.id}: android:${spec.attrName}=${spec.value}`);
    },
  };
  if (spec.credits) patch.credits = spec.credits;
  if (spec.optIn) patch.optIn = true;
  return patch;
}
