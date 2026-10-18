import { ATTR, makeBooleanFlagPatch } from './manifest-flags';
import { JARLPENGUIN_CREDITS } from './credits';

/** Marks the app data as fragile so Android 10+ offers to keep it when the game is uninstalled. */
export const keepDataOnUninstall = makeBooleanFlagPatch({
  id: 'keep-data-on-uninstall', target: 'application', attrName: 'hasFragileUserData', attrId: ATTR.hasFragileUserData,
  value: true, credits: JARLPENGUIN_CREDITS,
});
