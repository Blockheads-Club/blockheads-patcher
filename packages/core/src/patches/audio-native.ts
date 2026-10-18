import { encodeArmB, type NativeEdit } from '../native';
import { GAME_V174, GAME_V175, GAME_V176 } from './game-versions';

/**
 * Addresses of the audio / lifecycle code in `libApplication.so`, found with our own disassembly. The code itself is
 * identical in 1.7.4, 1.7.5 and 1.7.6 (same bytes at every site); only the addresses move. All of it is plain ARM code in
 * the read/execute segment (virtual address == file offset).
 */
export interface AudioSites {
  /** `-[MJSoundManager stopMusicForDeactivateEvent]` */
  stopMusic: number;
  /** `-[MJSoundManager restartMusicAfterActiveEvent:]` (an empty stub in the original) */
  restartMusic: number;
  /** `-[MJSoundManager setLoopMP3s:]` + 0x58 (`movw r2, #999`) */
  loopCount: number;
  /** `-[MJSoundManager playMP3IfSafe:]` */
  playWrapper: number;
  /** `bl`/`blx r3` that starts the menu track in `-[GameView initOpenGL]`, `gameSoundFinshedFadingOut` and `actuallyDoExitWorldRightNowReallyNow` */
  menuCalls: [number, number, number];
  /** `-[AVAudioPlayer play]` and `-[AVAudioPlayer pause]` */
  play: number;
  pause: number;
  /** `-[MJSoundManager playMP3IfSafe:withTimeOffset:]` and `-[MJSoundManager setLoopMP3s:]` */
  playWithOffset: number;
  setLoop: number;
  /** The call to `-[MainMenuUI selectMostRecentlyPlayedWorld]` inside `-[GameView didBecomeActive]` (start of the 9-word window) */
  selectWorld: number;
}

export const AUDIO_SITES = new Map<number, AudioSites>([
  [GAME_V174.versionCode, {
    stopMusic: 0xb8b698, restartMusic: 0xb8b714, loopCount: 0xb8c940, playWrapper: 0xb8b888,
    menuCalls: [0x9222e8, 0x93adec, 0x932858], play: 0x1e1798, pause: 0x1e19d4, playWithOffset: 0xb8b72c, setLoop: 0xb8c8e8,
    selectWorld: 0x9301b8,
  }],
  [GAME_V175.versionCode, {
    stopMusic: 0xb8b2c0, restartMusic: 0xb8b33c, loopCount: 0xb8c568, playWrapper: 0xb8b4b0,
    menuCalls: [0x921f10, 0x93aa14, 0x932480], play: 0x1e1598, pause: 0x1e17d4, playWithOffset: 0xb8b354, setLoop: 0xb8c510,
    selectWorld: 0x92fde0,
  }],
  [GAME_V176.versionCode, {
    stopMusic: 0xb8b168, restartMusic: 0xb8b1e4, loopCount: 0xb8c410, playWrapper: 0xb8b358,
    menuCalls: [0x921db8, 0x93a8bc, 0x932328], play: 0x1e1518, pause: 0x1e1754, playWithOffset: 0xb8b1fc, setLoop: 0xb8c3b8,
    selectWorld: 0x92fc88,
  }],
]);

const arm = (vaddr: number, original: number[], replacement: number[]): NativeEdit => ({ kind: 'arm', vaddr, original, replacement });

/** `ldr rd, [rn, #imm12]`, `ldrb`, `strb` encoders for the few fixed instructions the patches need. */
const LDR_R1_R0_6C = 0xe590106c; // ldr r1, [r0, #0x6c]      (mp3Player)
const MOV_R2_0 = 0xe3a02000; // mov r2, #0
const CMP_R1_0 = 0xe3510000;
const LDRBNE_R2_R1_2C = 0x15d1202c; // ldrbne r2, [r1, #0x2c]  (AVAudioPlayer._playing)
const STRB_R2_R0_72 = 0xe5c02072; // strb r2, [r0, #0x72]     (currentlyActive)
const CMP_R2_0 = 0xe3520000;
const MOVNE_R0_R1 = 0x11a00001;
const BX_LR = 0xe12fff1e;
const BXEQ_LR = 0x012fff1e;
const LDRB_R2_R0_72 = 0xe5d02072;
const LDRNE_R0_R0_6C = 0x1590006c;
const CMPNE_R0_0 = 0x13500000;

/** `-[MJSoundManager stopMusicForDeactivateEvent]` / `restartMusicAfterActiveEvent:` (pause, resume only if it was playing). */
export function musicResumeEdits(s: AudioSites): NativeEdit[] {
  return [
    arm(s.stopMusic,
      [0xe92d4c10, 0xe28db008, 0xe24dd010, 0xe59f2064, 0xe08f2002, 0xe3003000, 0xe59fc04c, 0xe79cc002, 0xe59fe048],
      // currentlyActive = (mp3Player != nil && mp3Player.playing); if it was playing, tail-call -[AVAudioPlayer pause].
      [LDR_R1_R0_6C, MOV_R2_0, CMP_R1_0, LDRBNE_R2_R1_2C, STRB_R2_R0_72, CMP_R2_0, MOVNE_R0_R1,
        encodeArmB(s.stopMusic + 28, s.pause, false, 0x1), BX_LR]),
    arm(s.restartMusic,
      [0xe24dd00c, 0xe58d0008, 0xe58d1004, 0xe5cd2003, 0xe28dd00c, 0xe12fff1e],
      // if (currentlyActive && mp3Player) tail-call -[AVAudioPlayer play]
      [LDRB_R2_R0_72, CMP_R2_0, LDRNE_R0_R0_6C, CMPNE_R0_0, BXEQ_LR, encodeArmB(s.restartMusic + 20, s.play)]),
  ];
}

const WRAPPER_ORIGINAL = [
  0xe92d4c10, 0xe28db008, 0xe24dd018, 0xe59f3054, 0xe08f3003, 0xe300c000, 0xed9f0b0e, 0xe59fe03c, 0xe79ee003, 0xe59f4038,
  0xe0843003, 0xe50b000c, 0xe58d1010, 0xe58d200c, 0xe51b000c,
];
/**
 * `-[MJSoundManager playMP3IfSafe:]` becomes two entry points. Entry A (the function address) keeps the old behaviour: play
 * with a time offset of 0.0. Entry B (+0x20) is "play the menu track": entry A, then `-[MJSoundManager setLoopMP3s:]` with the
 * stored `loopMP3s` flag, which now applies it to the new player.
 */
export function menuLoopEdits(s: AudioSites): NativeEdit[] {
  const w = s.playWrapper;
  const entryB = w + 0x20;
  const wrapper = [
    0xe92d4010, // push {r4, lr}
    0xe24dd008, // sub sp, sp, #8
    0xe3a03000, // mov r3, #0
    0xe58d3000, // str r3, [sp]       (time offset 0.0, low word)
    0xe58d3004, // str r3, [sp, #4]   (high word)
    encodeArmB(w + 0x14, s.playWithOffset, true),
    0xe28dd008, // add sp, sp, #8
    0xe8bd8010, // pop {r4, pc}
    0xe92d4010, // entry B: push {r4, lr}
    0xe1a04000, // mov r4, r0
    encodeArmB(w + 0x28, w, true), // bl entry A
    0xe5d42059, // ldrb r2, [r4, #0x59]   (loopMP3s)
    0xe1a00004, // mov r0, r4
    encodeArmB(w + 0x34, s.setLoop, true), // bl -[MJSoundManager setLoopMP3s:]
    0xe8bd8010, // pop {r4, pc}
  ];
  return [
    arm(s.loopCount, [0xe30023e7], [0xe3e02000]), // movw r2, #999 -> mvn r2, #0 (-1: the Java player only loops for -1)
    arm(w, WRAPPER_ORIGINAL, wrapper),
    ...s.menuCalls.map((site) => arm(site, [0xe12fff33], [encodeArmB(site, entryB, true)])), // blx r3 -> bl entry B
  ];
}

/** `-[GameView didBecomeActive]`: only select the most recently played world while no frame has been rendered yet. */
export function worldSelectionEdits(s: AudioSites): NativeEdit[] {
  return [arm(s.selectWorld,
    [0xe51b0020, 0xe51b1080, 0xe5912000, 0xe0800002, 0xe5900000, 0xe51b2094, 0xe5921000, 0xe51b307c, 0xe12fff33],
    [
      0xe320f000, // nop
      0xe51bc020, // ldr r12, [r11, #-0x20]    (self)
      0xe59c0014, // ldr r0, [r12, #0x14]      (mainMenuUI)
      0xe5dcc16a, // ldrb r12, [r12, #0x16a]   (hasRenderedFrameSinceActivate)
      0xe35c0000, // cmp r12, #0
      0xe51b2094, 0xe5921000, 0xe51b307c, // selector and objc_msgSend as before
      0x012fff33, // blxeq r3
    ])];
}
