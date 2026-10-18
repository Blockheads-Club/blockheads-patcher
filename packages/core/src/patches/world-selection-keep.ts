import { makeNativePatch } from '../native';
import { AUDIO_SITES, worldSelectionEdits } from './audio-native';
import { JARLPENGUIN_CREDITS } from './credits';
import { BLOCKHEADS_PACKAGE, GAME_LIB_PATH, GAME_V174, GAME_V175, GAME_V176 } from './game-versions';

/**
 * Every time the game becomes active again the main menu jumped back to the most recently played world. The call is now only
 * made while no frame has been rendered yet (the first activation after launch), so the selection survives leaving the app.
 */
export const worldSelectionKeep = makeNativePatch({
  id: 'world-selection-keep',
  packageName: BLOCKHEADS_PACKAGE,
  libPath: GAME_LIB_PATH,
  credits: JARLPENGUIN_CREDITS,
  versions: [GAME_V174, GAME_V175, GAME_V176].map((v) => ({ ...v, edits: worldSelectionEdits(AUDIO_SITES.get(v.versionCode)!) })),
});
