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
const IDS = ['fix-privacy-setting-dialog', 'fix-welcome-message-text', 'fix-invite-email-typo', 'signs-lowercase'];

interface Sample {
  name: string;
  path: string;
  versionCode: number;
  /** Instruction words that must differ (address -> [before, after]). */
  words: Record<number, [number, number]>;
  /** CFString data-pointer slots that are re-pointed (each followed by a length field). */
  slots: number[];
  appended: boolean;
}
const SAMPLES: Sample[] = [
  { name: '1.7.4', path: '/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk', versionCode: GAME_V174.versionCode, appended: true,
    words: { 0x944ad0: [0x1a00003a, 0x1a000077], 0x938ea8: [0xe50b008c, 0xe1a00000], 0x9ebdec: [0xe50b0064, 0xe1a00000], 0x9e58b8: [0xe12fff33, 0xe1a00000] },
    slots: [0xf92f98, 0xf976d8] },
  { name: '1.7.5', path: '/home/kahverengi/Downloads/The Blockheads_1.7.5_APKPure.apk', versionCode: GAME_V175.versionCode, appended: false,
    words: { 0x9446f8: [0x1a00003a, 0x1a000077], 0x938ad0: [0xe50b008c, 0xe1a00000], 0x9eba14: [0xe50b0064, 0xe1a00000], 0x9e54e0: [0xe12fff33, 0xe1a00000] },
    slots: [0xf91c18, 0xf96348] },
  { name: '1.7.6', path: process.env.BH_APK_176 ?? '/home/kahverengi/Downloads/The Blockheads_1.7.6.apk', versionCode: GAME_V176.versionCode, appended: false,
    words: { 0x9445a0: [0x1a00003a, 0x1a000077], 0x938978: [0xe50b008c, 0xe1a00000], 0x9eb8bc: [0xe50b0064, 0xe1a00000], 0x9e5388: [0xe12fff33, 0xe1a00000] },
    slots: [0xf91c00, 0xf96330] },
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
