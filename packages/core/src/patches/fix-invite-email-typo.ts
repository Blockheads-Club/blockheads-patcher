import { makeNativePatch, type NativeEdit } from '../native';
import { JARLPENGUIN_CREDITS } from './credits';
import { BLOCKHEADS_PACKAGE, GAME_LIB_PATH, GAME_V174, GAME_V175, GAME_V176 } from './game-versions';

/**
 * The "invite to world" e-mail body (shared by the share screen and the world list) reads "...from your mobile device join
 * my world...". The mailto: format string is a CFString constant, used by two objects that point at one C string; the
 * corrected, longer string is stored in new space and both CFStrings are re-pointed (and their length fields updated).
 */
const BEFORE = 'mailto:?to=&subject=%@&body=Click%%20the%%20link%%20below%%20from%%20your%%20mobile%%20device%%20join%%20my%%20world%%20in%%20The%%20Blockheads!%%0D%%0A%%0D%%0A%@';
const AFTER = BEFORE.replace('device%%20join', 'device%%20to%%20join');

/** `cfstrings` are the addresses of the CFString data-pointer slots; the length field follows each slot. */
const edit = (string: number, cfstrings: number[]): NativeEdit => ({
  kind: 'string', vaddr: string, original: BEFORE, replacement: AFTER,
  pointers: cfstrings.map((vaddr) => ({ vaddr, lengthVaddr: vaddr + 4 })),
});

export const fixInviteEmailTypo = makeNativePatch({
  id: 'fix-invite-email-typo',
  packageName: BLOCKHEADS_PACKAGE,
  libPath: GAME_LIB_PATH,
  credits: JARLPENGUIN_CREDITS,
  versions: [
    { ...GAME_V174, edits: [edit(0xf58140, [0xf92f98, 0xf976d8])] },
    { ...GAME_V175, edits: [edit(0xf56def, [0xf91c18, 0xf96348])] },
    { ...GAME_V176, edits: [edit(0xf56e09, [0xf91c00, 0xf96330])] },
  ],
});
