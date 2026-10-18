import { ATTR, makeBooleanFlagPatch } from './manifest-flags';
import { JARLPENGUIN_CREDITS } from './credits';

/** Opts the game in to audio playback capture (Android 10+), so screen recorders can record game sound. */
export const enableAudioCapture = makeBooleanFlagPatch({
  id: 'enable-audio-capture', target: 'application', attrName: 'allowAudioPlaybackCapture', attrId: ATTR.allowAudioPlaybackCapture,
  value: true, credits: JARLPENGUIN_CREDITS,
});
