import { makeNativePatch, type NativeEdit } from '../native';
import { JARLPENGUIN_CREDITS } from './credits';
import { BLOCKHEADS_PACKAGE, GAME_LIB_PATH, GAME_V174, GAME_V175, GAME_V176 } from './game-versions';

/**
 * Both places that render a server welcome message (`-[GameView viewServerWelcomeMessage:customRules:allowEdit:]` and
 * `-[InstructionsViewController updateServerWelcomeView]`) wrap the text in HTML and then delete every character outside
 * the printable ASCII range 32..126 (components separated by the inverted character set, joined with ""). That drops all
 * non-ASCII letters and any control character. The store of the filtered string back into the local variable is replaced
 * by a NOP, so the unfiltered text is used.
 */
const NOP = 0xe1a00000; // mov r0, r0
const store = (vaddr: number, original: number): NativeEdit => ({ kind: 'arm', vaddr, original: [original], replacement: [NOP] });
const STR_R0_M8C = 0xe50b008c; // str r0, [r11, #-0x8c]
const STR_R0_M64 = 0xe50b0064; // str r0, [r11, #-0x64]

export const fixWelcomeMessageText = makeNativePatch({
  id: 'fix-welcome-message-text',
  packageName: BLOCKHEADS_PACKAGE,
  libPath: GAME_LIB_PATH,
  credits: JARLPENGUIN_CREDITS,
  versions: [
    { ...GAME_V174, edits: [store(0x938ea8, STR_R0_M8C), store(0x9ebdec, STR_R0_M64)] },
    { ...GAME_V175, edits: [store(0x938ad0, STR_R0_M8C), store(0x9eba14, STR_R0_M64)] },
    { ...GAME_V176, edits: [store(0x938978, STR_R0_M8C), store(0x9eb8bc, STR_R0_M64)] },
  ],
});
