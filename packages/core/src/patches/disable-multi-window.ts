import { ATTR, MAIN_ACTIVITY, makeBooleanFlagPatch } from './manifest-flags';
import { JARLPENGUIN_CREDITS } from './credits';

/** The game UI is laid out once at start-up and breaks when resized; opt the game activity out of split-screen and freeform. */
export const disableMultiWindow = makeBooleanFlagPatch({
  id: 'disable-multi-window', target: { activity: MAIN_ACTIVITY }, attrName: 'resizeableActivity', attrId: ATTR.resizeableActivity,
  value: false, credits: JARLPENGUIN_CREDITS,
});
