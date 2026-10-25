import { ANDROID_NS, getAttr, removeElement } from '../axml';
import { BLOCKHEADS_PACKAGE, findApplication } from './manifest-flags';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const MAX_ASPECT_META = 'android.max_aspect';
const ID_NAME = 0x01010003;

function metaElement(ctx: PatchContext) {
  const app = findApplication(ctx);
  const el = app?.children.find((c) => c.name === 'meta-data' && getAttr(c, 'name', ANDROID_NS, ID_NAME)?.stringValue === MAX_ASPECT_META);
  return { app, el };
}

function detect(ctx: PatchContext): PatchStatus {
  const { app, el } = metaElement(ctx);
  if (!app) return 'incompatible';
  return el ? 'notApplied' : 'applied';
}

/**
 * The game declares `<meta-data android:name="android.max_aspect" android:value="2.1"/>`: it asks Android not to give it a
 * window taller than 2.1 : 1. The cover screen of a foldable is 2.56 : 1, so Android (and One UI's own compatibility
 * layer, which also shows its "not optimised for big screens" notice for apps with such a limit) letterboxes the game or
 * puts it into size-compatibility mode there. The game lays itself out from the real window size, so the limit is only a
 * leftover; removing it lets the game use the whole screen.
 */
export const removeMaxAspect: Patch = {
  id: 'remove-max-aspect',
  version: 1,
  nameKey: 'patch.remove-max-aspect.name',
  descriptionKey: 'patch.remove-max-aspect.description',
  appliesTo: { packageName: BLOCKHEADS_PACKAGE },
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`remove-max-aspect cannot be applied (status: ${status})`, 'cannotApply', { status });
    const { app, el } = metaElement(ctx);
    removeElement(ctx.manifest, app!, el!);
    ctx.markManifestDirty();
    ctx.log('remove-max-aspect: android.max_aspect removed');
  },
};
