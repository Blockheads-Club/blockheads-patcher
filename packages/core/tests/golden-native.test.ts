import { haveApk } from './helpers';
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { ElfImage, GAME_LIB_PATH, GAME_V174, GAME_V175, GAME_V176, MemoryKeystore, applyPatches, getEntry, listPatches, loadApk, patchApk, readZip } from '../src/index';

const BT = join(homedir(), 'Android/Sdk/build-tools/35.0.0');
const tools = existsSync(join(BT, 'apksigner')) && existsSync(join(BT, 'zipalign'));
const IDS = ['fix-privacy-setting-dialog', 'fix-welcome-message-text', 'fix-invite-email-typo', 'signs-lowercase', 'music-resume', 'menu-music-loop', 'world-selection-keep'];

interface Sample {
  name: string;
  path: string;
  versionCode: number;
  /** Instruction words that must differ (address -> [before, after]). */
  words: Record<number, [number, number]>;
  /** CFString data-pointer slots that are re-pointed (each followed by a length field). */
  slots: number[];
  appended: boolean;
  /** Audio / lifecycle patch sites (hand-checked against our own analysis): address -> new words. */
  audio: Record<number, number[]>;
}
/** New words that are identical in every version (analysis-audio-lifecycle.md, section 6). */
const COMMON_AUDIO: Record<string, number[]> = {
  stop: [0xe590106c, 0xe3a02000, 0xe3510000, 0x15d1202c, 0xe5c02072, 0xe3520000, 0x11a00001, 0, 0xe12fff1e],
  restart: [0xe5d02072, 0xe3520000, 0x1590006c, 0x13500000, 0x012fff1e, 0],
  loop: [0xe3e02000],
  wrapper: [0xe92d4010, 0xe24dd008, 0xe3a03000, 0xe58d3000, 0xe58d3004, 0xebffffa2, 0xe28dd008, 0xe8bd8010,
    0xe92d4010, 0xe1a04000, 0xebfffff4, 0xe5d42059, 0xe1a00004, 0xeb000409, 0xe8bd8010],
  select: [0xe320f000, 0xe51bc020, 0xe59c0014, 0xe5dcc16a, 0xe35c0000, 0xe51b2094, 0xe5921000, 0xe51b307c, 0x012fff33],
};
const audioWords = (stop: number, restart: number, loop: number, wrapper: number, calls: number[], select: number, pause: number, play: number): Record<number, number[]> => ({
  [stop]: COMMON_AUDIO.stop!.map((w, i) => (i === 7 ? pause : w)),
  [restart]: COMMON_AUDIO.restart!.map((w, i) => (i === 5 ? play : w)),
  [loop]: COMMON_AUDIO.loop!,
  [wrapper]: COMMON_AUDIO.wrapper!,
  ...Object.fromEntries(calls.map((c, i) => [c, [[0xeb09a56e, 0xeb0942ad, 0xeb096412][i]!]])),
  [select]: COMMON_AUDIO.select!,
});
const SAMPLES: Sample[] = [
  { name: '1.7.4', path: '/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk', versionCode: GAME_V174.versionCode, appended: true,
    words: { 0x944ad0: [0x1a00003a, 0x1a000077], 0x938ea8: [0xe50b008c, 0xe1a00000], 0x9ebdec: [0xe50b0064, 0xe1a00000], 0x9e58b8: [0xe12fff33, 0xe1a00000] },
    slots: [0xf92f98, 0xf976d8],
    audio: audioWords(0xb8b698, 0xb8b714, 0xb8c940, 0xb8b888, [0x9222e8, 0x93adec, 0x932858], 0x9301b8, 0x1ad958c6, 0xead9581a) },
  { name: '1.7.5', path: '/home/kahverengi/Downloads/The Blockheads_1.7.5_APKPure.apk', versionCode: GAME_V175.versionCode, appended: false,
    words: { 0x9446f8: [0x1a00003a, 0x1a000077], 0x938ad0: [0xe50b008c, 0xe1a00000], 0x9eba14: [0xe50b0064, 0xe1a00000], 0x9e54e0: [0xe12fff33, 0xe1a00000] },
    slots: [0xf91c18, 0xf96348],
    audio: audioWords(0xb8b2c0, 0xb8b33c, 0xb8c568, 0xb8b4b0, [0x921f10, 0x93aa14, 0x932480], 0x92fde0, 0x1ad9593c, 0xead95890) },
  { name: '1.7.6', path: process.env.BH_APK_176 ?? '/home/kahverengi/Downloads/The Blockheads_1.7.6.apk', versionCode: GAME_V176.versionCode, appended: false,
    words: { 0x9445a0: [0x1a00003a, 0x1a000077], 0x938978: [0xe50b008c, 0xe1a00000], 0x9eb8bc: [0xe50b0064, 0xe1a00000], 0x9e5388: [0xe12fff33, 0xe1a00000] },
    slots: [0xf91c00, 0xf96330],
    audio: audioWords(0xb8b168, 0xb8b1e4, 0xb8c410, 0xb8b358, [0x921db8, 0x93a8bc, 0x932328], 0x92fc88, 0x1ad95972, 0xead958c6) },
];

for (const s of SAMPLES) {
  describe.skipIf(!haveApk(s.path))(`golden native patches: ${s.name}`, () => {
    let input: Uint8Array;
    let output: Uint8Array;
    beforeAll(async () => {
      input = new Uint8Array(readFileSync(s.path));
      const res = await patchApk(input, { patchIds: IDS, keystore: new MemoryKeystore() });
      expect(res.applied).toEqual(IDS);
      output = res.bytes;
    }, 300_000);

    it('detects notApplied on the input and applied on the output', async () => {
      const state = async (b: Uint8Array) => listPatches(await loadApk(b)).filter((r) => IDS.includes(r.patch.id)).map((r) => r.status);
      expect(await state(input)).toEqual(IDS.map(() => 'notApplied'));
      expect(await state(output)).toEqual(IDS.map(() => 'applied'));
      expect(applyPatches(await loadApk(output), IDS).skipped.map((x) => x.status)).toEqual(IDS.map(() => 'applied'));
    }, 300_000);

    it('changes only the intended bytes of libApplication.so', () => {
      const a = getEntry(readZip(input), GAME_LIB_PATH)!.data, b = getEntry(readZip(output), GAME_LIB_PATH)!.data;
      const before = new ElfImage(a), after = new ElfImage(b);
      const allowed: [number, number][] = [[0x34, 0x134]]; // program header table
      for (const [addr, [was, now]] of Object.entries(s.words)) {
        expect(before.readU32(Number(addr))).toBe(was);
        expect(after.readU32(Number(addr))).toBe(now);
        const o = before.offsetOf(Number(addr), 4)!;
        allowed.push([o, o + 4]);
      }
      for (const [addr, words] of Object.entries(s.audio)) {
        const o = before.offsetOf(Number(addr), words.length * 4)!;
        words.forEach((w, i) => expect(after.readU32(Number(addr) + i * 4)).toBe(w));
        allowed.push([o, o + words.length * 4]);
      }
      for (const slot of s.slots) {
        const o = before.offsetOf(slot, 8)!;
        allowed.push([o, o + 8]);
        expect(after.readU32(slot)).not.toBe(before.readU32(slot));
        expect(after.readCString(after.readU32(slot)!)).toContain('device%%20to%%20join');
      }
      const firstEnd = before.segments[2]!.offset + before.segments[2]!.filesz;
      if (s.appended) {
        expect(b.length).toBeGreaterThan(a.length);
        allowed.push([a.length, b.length]);
      } else {
        expect(b.length).toBe(a.length);
        allowed.push([firstEnd, firstEnd + 0xa9]);
      }
      let stray = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !allowed.some(([lo, hi]) => i >= lo && i < hi)) stray++;
      expect(stray).toBe(0);
    });

    it.skipIf(!tools)('apksigner verifies v1 + v2 and zipalign passes', () => {
      const dir = mkdtempSync(join(tmpdir(), 'bhp-native-'));
      try {
        const p = join(dir, 'out.apk');
        writeFileSync(p, output);
        const v = spawnSync(join(BT, 'apksigner'), ['verify', '--verbose', p], { encoding: 'utf8' });
        expect(v.stdout).toContain('v1 scheme (JAR signing): true');
        expect(v.stdout).toContain('v2 scheme (APK Signature Scheme v2): true');
        expect(spawnSync(join(BT, 'zipalign'), ['-c', '-p', '4', p]).status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
