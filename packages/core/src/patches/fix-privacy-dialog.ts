import { makeNativePatch, type NativeEdit } from '../native';
import { JARLPENGUIN_CREDITS } from './credits';
import { BLOCKHEADS_PACKAGE, GAME_LIB_PATH, GAME_V174, GAME_V175, GAME_V176 } from './game-versions';

/**
 * `-[GameView alertView:clickedButtonAtIndex:]` stores the answer of the data-privacy prompt when the clicked alert is that
 * prompt, but the "Privacy Setting Changed ... restart the game" alert is shown after the `if` instead of inside it, so it
 * pops up for every other alert the game view handles. The conditional branch that skips the privacy handling for other
 * alerts is re-targeted at the method epilogue (a 4-byte ARM branch edit per version).
 */
const BNE_SKIP_TO_SHOW = 0x1a00003a; // bne <show "Privacy Setting Changed">
const BNE_SKIP_TO_RETURN = 0x1a000077; // bne <epilogue> (0x1dc bytes further on)
const edit = (vaddr: number): NativeEdit => ({ kind: 'arm', vaddr, original: [BNE_SKIP_TO_SHOW], replacement: [BNE_SKIP_TO_RETURN] });

export const fixPrivacyDialog = makeNativePatch({
  id: 'fix-privacy-setting-dialog',
  packageName: BLOCKHEADS_PACKAGE,
  libPath: GAME_LIB_PATH,
  credits: JARLPENGUIN_CREDITS,
  versions: [
    { ...GAME_V174, edits: [edit(0x944ad0)] },
    { ...GAME_V175, edits: [edit(0x9446f8)] },
    { ...GAME_V176, edits: [edit(0x9445a0)] },
  ],
});
