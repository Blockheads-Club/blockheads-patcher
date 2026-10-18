import { ANDROID_NS, ValueType, getAttr, setAttrValue, findElements } from '../axml';
import { JARLPENGUIN_CREDITS } from './credits';
import { ATTR, BLOCKHEADS_PACKAGE, findApplication, readBool, writeBool } from './manifest-flags';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const TARGET_SDK = 29;
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
 * Raises targetSdkVersion to 29 (Android 10). The game was built for 27. Behaviour changes that matter for it, and how
 * they are neutralised: cleartext HTTP is blocked from 28 (the game talks to http:// endpoints) -> usesCleartextTraffic;
 * scoped storage starts at 29 -> requestLegacyExternalStorage keeps the old file access. Version 30+ is avoided on purpose
 * (package visibility, scoped storage cannot be opted out of).
 */
export const raiseTargetSdk: Patch = {
  id: 'raise-target-sdk',
  version: 1,
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
    writeBool(ctx, app, 'requestLegacyExternalStorage', ATTR.requestLegacyExternalStorage, true);
    ctx.markManifestDirty();
    ctx.log(`targetSdkVersion=${TARGET_SDK}, usesCleartextTraffic and requestLegacyExternalStorage enabled`);
  },
};
