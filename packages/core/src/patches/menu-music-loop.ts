import { makeNativePatch } from '../native';
import { AUDIO_SITES, menuLoopEdits } from './audio-native';
import { JARLPENGUIN_CREDITS } from './credits';
import { BLOCKHEADS_PACKAGE, GAME_LIB_PATH, GAME_V174, GAME_V175, GAME_V176 } from './game-versions';

/**
 * The main-menu track never looped: the loop count the game passes is 999, which the Android player does not treat as
 * "forever" (only -1), and the flag is set before a track exists. The count becomes -1, and the three places that start the
 * menu track call a new entry point that applies the flag after starting it. Other tracks (in-world music) are not looped.
 */
export const menuMusicLoop = makeNativePatch({
  id: 'menu-music-loop',
  packageName: BLOCKHEADS_PACKAGE,
  libPath: GAME_LIB_PATH,
  credits: JARLPENGUIN_CREDITS,
  versions: [GAME_V174, GAME_V175, GAME_V176].map((v) => ({ ...v, edits: menuLoopEdits(AUDIO_SITES.get(v.versionCode)!) })),
});
