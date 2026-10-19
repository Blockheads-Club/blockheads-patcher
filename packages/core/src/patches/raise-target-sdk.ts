import { ANDROID_NS, ValueType, getAttr, setAttrValue, findElements } from '../axml';
import { JARLPENGUIN_CREDITS } from './credits';
import { ATTR, BLOCKHEADS_PACKAGE, findApplication, readBool, writeBool } from './manifest-flags';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const TARGET_SDK = 28;
const ID_TARGET_SDK = 0x01010270;

const targetAttr = (ctx: PatchContext) => {
  const sdk = findElements(ctx.manifest, (e, path) => e.name === 'uses-sdk' && path.join('/') === 'manifest/uses-sdk')[0];
  const a = sdk && getAttr(sdk, 'targetSdkVersion', ANDROID_NS, ID_TARGET_SDK);
  return a && (a.valueType === ValueType.IntDec || a.valueType === ValueType.IntHex) ? a : undefined;
};

function detect(ctx: PatchContext): PatchStatus {
  const a = targetAttr(ctx);
  const app = findApplication(ctx);
  if (!a || !app) return 'incompatible';
  if (a.data < TARGET_SDK) return 'notApplied';
  return readBool(app, 'usesCleartextTraffic', ATTR.usesCleartextTraffic) === true ? 'applied' : 'notApplied';
}

/**
 * Raises targetSdkVersion to 28 (Android 9). The game was built for 27. Android 14 shows its "built for an older version of
 * Android" dialog below `ro.build.version.min_supported_target_sdk`, which is 28. 28 is also the highest target that
 * works: from 29 the hidden-API list `max-target-p` is blocked, and Apportable's native `com.apportable.ui.View.nativeSetFrame`
 * looks up the hidden `View.setFrame(IIII)Z` via JNI and aborts the game at start when the lookup fails (device-tested on
 * Android 14). The one behaviour change at 28 that matters, cleartext HTTP being blocked (the game talks to http://
 * endpoints), is neutralised with usesCleartextTraffic.
 */
export const raiseTargetSdk: Patch = {
  id: 'raise-target-sdk',
  version: 2,
  nameKey: 'patch.raise-target-sdk.name',
  descriptionKey: 'patch.raise-target-sdk.description',
  appliesTo: { packageName: BLOCKHEADS_PACKAGE, versionNames: ['1.7.4', '1.7.5', '1.7.6'] },
  credits: JARLPENGUIN_CREDITS,
  optIn: true,
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`raise-target-sdk cannot be applied (status: ${status})`, 'cannotApply', { status });
    const a = targetAttr(ctx)!;
    if (a.data < TARGET_SDK) setAttrValue(ctx.manifest, a, ValueType.IntDec, TARGET_SDK);
    const app = findApplication(ctx)!;
    writeBool(ctx, app, 'usesCleartextTraffic', ATTR.usesCleartextTraffic, true);
    ctx.markManifestDirty();
    ctx.log(`targetSdkVersion=${TARGET_SDK}, usesCleartextTraffic enabled`);
  },
};
