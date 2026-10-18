import { makeNativePatch, type NativeEdit } from '../native';
import { JARLPENGUIN_CREDITS } from './credits';
import { BLOCKHEADS_PACKAGE, GAME_LIB_PATH, GAME_V174, GAME_V175, GAME_V176 } from './game-versions';

/**
 * `-[BlockTextPromptAlertView text]` (the sign text editor) word-wraps the text and then sends it `uppercaseString`. The
 * `blx r3` that performs that send becomes a NOP, so the wrapped string in r0 is returned unchanged and lowercase letters
 * survive. The five words around the site are verified (`mov r0,lr; str r1; mov r1,r12; blx r3; str r0`).
 */
const BEFORE = [0xe1a0000e, 0xe58d100c, 0xe1a0100c, 0xe12fff33, 0xe50b003c];
const AFTER = [0xe1a0000e, 0xe58d100c, 0xe1a0100c, 0xe1a00000, 0xe50b003c];
const edit = (blx: number): NativeEdit => ({ kind: 'arm', vaddr: blx - 12, original: BEFORE, replacement: AFTER });

export const signsLowercase = makeNativePatch({
  id: 'signs-lowercase',
  packageName: BLOCKHEADS_PACKAGE,
  libPath: GAME_LIB_PATH,
  credits: JARLPENGUIN_CREDITS,
  versions: [
    { ...GAME_V174, edits: [edit(0x9e58b8)] },
    { ...GAME_V175, edits: [edit(0x9e54e0)] },
    { ...GAME_V176, edits: [edit(0x9e5388)] },
  ],
});
