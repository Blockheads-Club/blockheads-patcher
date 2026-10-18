import { BLOCKHEADS_PACKAGE } from './manifest-flags';

/** The Android release builds of The Blockheads that native patches are pinned to. */
export const GAME_LIB_PATH = 'lib/armeabi-v7a/libApplication.so';
export const GAME_V174 = {
  versionCode: 1548230154, versionName: '1.7.4', libSha256: 'e40f53436fe3028aefaa678f2312aab9d2a9a024747aa797d6334494cf225861',
} as const;
export const GAME_V175 = {
  versionCode: 1557164436, versionName: '1.7.5', libSha256: 'd09418e9c0865902054a71358dcff3264d47f7b24ede58667cb5ea0e6f269b96',
} as const;
export const GAME_V176 = {
  versionCode: 1564553369, versionName: '1.7.6', libSha256: '733d821027d69de329d0ba171df2e6013d612edf5a4d327badd001acc30b94c7',
} as const;
export { BLOCKHEADS_PACKAGE };
