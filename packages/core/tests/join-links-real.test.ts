import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchApk, MemoryKeystore } from '../src/index';
import { haveApk } from './helpers';

const BT = join(homedir(), 'Android/Sdk/build-tools/35.0.0');
const tools = existsSync(join(BT, 'apksigner')) && existsSync(join(BT, 'aapt2'));
const APKS = [
  ['1.7.4', '/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk'],
  ['1.7.5', '/home/kahverengi/Downloads/The Blockheads_1.7.5_APKPure.apk'],
  ['1.7.6', process.env.BH_APK_176 ?? '/home/kahverengi/Downloads/The Blockheads_1.7.6.apk'],
] as const;

for (const [name, path] of APKS) {
  describe.skipIf(!haveApk(path) || !tools)(`fix-join-links on the real ${name} APK`, () => {
    it('writes valid filters that aapt2 parses and apksigner verifies', async () => {
      const res = await patchApk(new Uint8Array(readFileSync(path)), { patchIds: ['fix-join-links'], keystore: new MemoryKeystore() });
      const dir = mkdtempSync(join(tmpdir(), 'bhjl-'));
      try {
        const out = join(dir, 'o.apk');
        writeFileSync(out, res.bytes);
        const tree = spawnSync(join(BT, 'aapt2'), ['dump', 'xmltree', '--file', 'AndroidManifest.xml', out], { encoding: 'utf8', maxBuffer: 1 << 26 });
        expect(tree.status).toBe(0);
        expect(tree.stdout).toContain('scheme(0x01010027)="blockheads"');
        expect(tree.stdout).toContain('path(0x0101002a)="/join.php"');
        expect(tree.stdout).toContain('host(0x01010028)="theblockheads.net"');
        expect(tree.stdout).not.toContain('theblockheads.net/join"');
        const sig = spawnSync(join(BT, 'apksigner'), ['verify', '--verbose', out], { encoding: 'utf8' });
        expect(sig.stdout).toContain('v1 scheme (JAR signing): true');
        expect(sig.stdout).toContain('v2 scheme (APK Signature Scheme v2): true');
        expect(sig.status).toBe(0);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 180_000);
  });
}
