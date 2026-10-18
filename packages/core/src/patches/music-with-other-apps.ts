import { CodeBuilder } from '../dex';
import { JARLPENGUIN_CREDITS } from './credits';
import { makeMethodRewritePatch, type MethodRewriteSpec } from './method-rewrite';

export const AUDIO_MANAGER_CLASS = 'Lcom/apportable/media/AndroidAudioManager;';

/**
 * At start-up the game asks `AndroidAudioManager.isMusicActive()` whether another app is playing and, if so, never
 * plays its music for the whole session (a literal port of the iOS "do not play over the user's music" rule). The
 * method just returns a cached flag, so it is rewritten to return false: the game's music then mixes with the other
 * app's audio, which is what the game's own (mixing) audio category intends.
 */
export const musicWithOtherAppsSpec: MethodRewriteSpec = {
  id: 'music-with-other-apps',
  credits: JARLPENGUIN_CREDITS,
  cls: AUDIO_MANAGER_CLASS,
  method: { name: 'isMusicActive', params: [], returnType: 'Z' },
  original: (dex) => new CodeBuilder({ registers: 2 })
    .op('iget-boolean', 0, 1, dex.field(AUDIO_MANAGER_CLASS, 'mIsOtherMusicActive', 'Z'))
    .op('return', 0),
  patched: () => new CodeBuilder({ registers: 2 }).op('const/4', 0, 0).op('return', 0),
  logMessage: 'AndroidAudioManager.isMusicActive() now always returns false',
};
export const musicWithOtherApps = makeMethodRewritePatch(musicWithOtherAppsSpec);
