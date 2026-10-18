import { makeNativePatch } from '../native';
import { AUDIO_SITES, musicResumeEdits } from './audio-native';
import { JARLPENGUIN_CREDITS } from './credits';
import { BLOCKHEADS_PACKAGE, GAME_LIB_PATH, GAME_V174, GAME_V175, GAME_V176 } from './game-versions';

/**
 * Going to the background used to destroy the music player and nothing restarted it. The two `MJSoundManager` lifecycle
 * methods are rewritten in place: leaving pauses the player and remembers whether it was playing, returning resumes it only
 * in that case.
 */
export const musicResume = makeNativePatch({
  id: 'music-resume',
  packageName: BLOCKHEADS_PACKAGE,
  libPath: GAME_LIB_PATH,
  credits: JARLPENGUIN_CREDITS,
  versions: [GAME_V174, GAME_V175, GAME_V176].map((v) => ({ ...v, edits: musicResumeEdits(AUDIO_SITES.get(v.versionCode)!) })),
});
