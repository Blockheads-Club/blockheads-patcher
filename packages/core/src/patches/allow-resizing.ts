import { ATTR, MAIN_ACTIVITY, makeBooleanFlagPatch } from './manifest-flags';

/**
 * Declares the game activity resizable. An earlier patch here (`disable-multi-window`, after JarlPenguin's) made it
 * non-resizable; on a foldable's cover screen Android then letterboxes the game, hiding the status bar changes the
 * window, and the configuration change it receives crashes Apportable's view thread at every start
 * (`CalledFromWrongThreadException`, seen on a Galaxy Z Fold4). Writing `true` is what Android assumes for this
 * target anyway, and it repairs a game patched with that earlier patch.
 */
export const allowResizing = makeBooleanFlagPatch({
  id: 'allow-resizing', target: { activity: MAIN_ACTIVITY }, attrName: 'resizeableActivity', attrId: ATTR.resizeableActivity,
  value: true,
});
