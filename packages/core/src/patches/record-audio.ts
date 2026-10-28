import { ANDROID_NS, findElementsByName, insertElement } from '../axml';
import { BLOCKHEADS_PACKAGE } from './manifest-flags';
import { PatchError, type Patch, type PatchContext, type PatchStatus } from './types';

export const RECORD_AUDIO_PERMISSION = 'android.permission.RECORD_AUDIO';
const ID_NAME = 0x01010003;

const hasPermission = (ctx: PatchContext): boolean => findElementsByName(ctx.manifest, 'uses-permission', RECORD_AUDIO_PERMISSION).length > 0;

function detect(ctx: PatchContext): PatchStatus {
  if (ctx.manifest.root.name !== 'manifest') return 'incompatible';
  return hasPermission(ctx) ? 'applied' : 'notApplied';
}

/**
 * Declares the dangerous permission `RECORD_AUDIO`, which the game (1.7.4 to 1.7.6, targetSdk 27) never asks for, so the
 * Blockheads Club mod loader can capture the microphone for voice chat mods. Declaring it grants nothing by itself: the
 * mod loader requests the runtime permission only when the player turns voice chat on. Kept separate from mod-loader
 * (whose version follows the pinned loader build) so players who never want a microphone permission can leave it off.
 * Device test: `adb shell dumpsys package com.noodlecake.blockheads | grep RECORD_AUDIO` must list the permission
 * (`granted=false` until voice chat is turned on in a mod).
 */
export const recordAudio: Patch = {
  id: 'record-audio',
  version: 1,
  nameKey: 'patch.record-audio.name',
  descriptionKey: 'patch.record-audio.description',
  appliesTo: { packageName: BLOCKHEADS_PACKAGE, versionNames: ['1.7.4', '1.7.5', '1.7.6'] },
  optIn: true,
  detect,
  apply(ctx) {
    const status = detect(ctx);
    if (status !== 'notApplied') throw new PatchError(`record-audio cannot be applied (status: ${status})`, 'cannotApply', { status });
    const root = ctx.manifest.root;
    const last = root.children.map((c, i) => (c.name === 'uses-permission' ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    insertElement(ctx.manifest, root, { name: 'uses-permission', attributes: [{ name: 'name', nsUri: ANDROID_NS, resourceId: ID_NAME, value: RECORD_AUDIO_PERMISSION }] }, last + 1);
    ctx.markManifestDirty();
    ctx.log(`record-audio: added ${RECORD_AUDIO_PERMISSION}`);
  },
};
