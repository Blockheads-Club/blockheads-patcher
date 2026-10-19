import { haveApk, sameContent } from './helpers';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadApk, listPatches, patchApk, MemoryKeystore, readZip, getEntry, defaultRegistry, createRegistry, fixWelcomePopupDeadlock, applyPatches, PatchError } from '../src/index';

const BT = join(homedir(), 'Android/Sdk/build-tools/35.0.0');
const tools = existsSync(join(BT, 'apksigner')) && existsSync(join(BT, 'aapt2')) && existsSync(join(BT, 'zipalign'));
const APKS = [
  { name: '1.7.4', path: '/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk', out: true },
  { name: '1.7.5', path: '/home/kahverengi/Downloads/The Blockheads_1.7.5_APKPure.apk', out: false },
  { name: '1.7.6', path: process.env.BH_APK_176 ?? '/home/kahverengi/Downloads/The Blockheads_1.7.6.apk', out: true },
];

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });
/** The suite for one game version; each version has its own test file so the versions run in parallel. */
export function goldenSuite(version: string): void {
  const apk = APKS.find((a) => a.name === version)!;
  describe.skipIf(!haveApk(apk.path) || !tools)(`golden: patch Blockheads ${apk.name}`, () => {
    let input: Uint8Array;
    let output: Uint8Array;
    let outPath: string;
    const ks = new MemoryKeystore();
    let certSha = '';
    const ids = ['fix-welcome-popup-deadlock'];

    beforeAll(async () => {
      input = new Uint8Array(readFileSync(apk.path));
      const res = await patchApk(input, { patchIds: ids, keystore: ks });
      output = res.bytes;
      certSha = res.certSha256;
      expect(res.applied).toEqual(ids);
      if (apk.out) {
        const dir = resolve(__dirname, '../../../.local-out');
        mkdirSync(dir, { recursive: true });
        outPath = join(dir, `patched-${apk.name}.apk`);
      } else {
        const d = mkdtempSync(join(tmpdir(), 'bhp-'));
        tmpDirs.push(d);
        outPath = join(d, `patched-${apk.name}.apk`);
      }
      rmSync(outPath, { force: true });
      writeFileSync(outPath, output);
    }, 180_000);

    it('detect: notApplied on input, applied on output', async () => {
      const a = listPatches(await loadApk(input));
      expect([a[0]!.patch.id, a[0]!.status]).toEqual(['fix-welcome-popup-deadlock', 'notApplied']);
      expect(a.some((x) => x.patch.id === 'fix-iap-store-font-crash')).toBe(false);
      expect(NEW_PATCHES.map((id) => [id, a.find((x) => x.patch.id === id)?.status])).toEqual(NEW_PATCHES.map((id) => [id, 'notApplied']));
      const b = listPatches(await loadApk(output));
      expect(b[0]!.status).toBe('applied');
    }, 120_000);

    it('second apply on patched output throws', async () => {
      const loaded = await loadApk(output);
      expect(applyPatches(loaded, ids).skipped.map((x) => x.status)).toEqual(ids.map(() => 'applied'));
      expect(() => fixWelcomePopupDeadlock.apply({ zip: loaded.zip, manifest: loaded.manifest, info: loaded.info, markManifestDirty() {}, log() {} })).toThrow(PatchError);
    });

    it('apksigner verifies v1 + v2', () => {
      const r = run(join(BT, 'apksigner'), ['verify', '--verbose', outPath]);
      expect(r.out).toContain('Verifies');
      expect(r.out).toContain('v1 scheme (JAR signing): true');
      expect(r.out).toContain('v2 scheme (APK Signature Scheme v2): true');
      expect(r.code).toBe(0);
    });

    it('zipalign -c -p 4 passes', () => {
      expect(run(join(BT, 'zipalign'), ['-c', '-p', '4', outPath]).code).toBe(0);
    });

    it('aapt2 shows theme @0x01030011 on BlockheadsWebView', () => {
      const r = run(join(BT, 'aapt2'), ['dump', 'xmltree', '--file', 'AndroidManifest.xml', outPath]);
      expect(r.code).toBe(0);
      const i = r.out.indexOf('com.noodlecake.noodlewebview.BlockheadsWebView');
      expect(i).toBeGreaterThan(0);
      const el = r.out.slice(r.out.lastIndexOf('E: activity', i), r.out.indexOf('E: ', i));
      expect(el).toMatch(/android:theme.*=@0x01030011/);
    });

    it('all other entries are content-identical', () => {
      const a = readZip(input), b = readZip(output);
      const isSig = (n: string) => /^META-INF\/(MANIFEST\.MF|[^/]+\.(SF|RSA|DSA|EC)|SIG-.*)$/i.test(n);
      const changed = (n: string) => n === 'AndroidManifest.xml';
      const ea = a.entries.filter((e) => !isSig(e.name) && !changed(e.name));
      const eb = b.entries.filter((e) => !isSig(e.name) && !changed(e.name));
      expect(eb.map((e) => e.name)).toEqual(ea.map((e) => e.name));
      for (let i = 0; i < ea.length; i++) {
        expect(sameContent(ea[i]!, eb[i]!), ea[i]!.name).toBe(true);
        expect(eb[i]!.method, ea[i]!.name).toBe(ea[i]!.method);
      }
    });

    it('re-patching with the same keystore keeps the signing certificate', async () => {
      const again = await patchApk(input, { patchIds: ids, keystore: ks });
      expect(again.certSha256).toBe(certSha);
    }, 120_000);
  });
}

const NEW_PATCHES = ['enable-audio-capture', 'keep-data-on-uninstall', 'allow-resizing', 'raise-target-sdk', 'fix-join-links', 'adaptive-icon', 'fix-config-change-crash'];

const GUARD_APK = APKS[2]!;
/** The cross-patch 1.7.6 check and the registry tests (run once, from golden.test.ts). */
export function goldenExtras(): void {
  describe.skipIf(!haveApk(GUARD_APK.path) || !tools)('golden: 1.7.6 with fix-welcome-popup-deadlock + fix-config-change-crash', () => {
    const ids = ['fix-welcome-popup-deadlock', 'fix-config-change-crash'];
    const outPath = join(resolve(__dirname, '../../../.local-out'), 'guard-1.7.6.apk');
    let output: Uint8Array;

    beforeAll(async () => {
      const res = await patchApk(new Uint8Array(readFileSync(GUARD_APK.path)), { patchIds: ids, keystore: new MemoryKeystore() });
      expect(res.applied).toEqual(ids);
      output = res.bytes;
      mkdirSync(resolve(outPath, '..'), { recursive: true });
      rmSync(outPath, { force: true });
      writeFileSync(outPath, output);
    }, 180_000);

    it('both patches report applied and the APK verifies (v1 + v2, zipalign)', async () => {
      const st = listPatches(await loadApk(output));
      expect(ids.map((id) => st.find((x) => x.patch.id === id)!.status)).toEqual(['applied', 'applied']);
      const r = run(join(BT, 'apksigner'), ['verify', '--verbose', outPath]);
      expect(r.out).toContain('v1 scheme (JAR signing): true');
      expect(r.out).toContain('v2 scheme (APK Signature Scheme v2): true');
      expect(r.code).toBe(0);
      expect(run(join(BT, 'zipalign'), ['-c', '-p', '4', outPath]).code).toBe(0);
    }, 120_000);

    it('only the manifest and classes.dex change', () => {
      const a = readZip(new Uint8Array(readFileSync(GUARD_APK.path))), b = readZip(output);
      const isSig = (n: string) => /^META-INF\/(MANIFEST\.MF|[^/]+\.(SF|RSA|DSA|EC)|SIG-.*)$/i.test(n);
      const changed = b.entries.filter((e) => !isSig(e.name) && !sameContent(e, getEntry(a, e.name)!)).map((e) => e.name);
      expect(changed.sort()).toEqual(['AndroidManifest.xml', 'classes.dex']);
    });
  });

  describe('registry', () => {
    it('default registry has the welcome fix, not the retired IAP stub; duplicates rejected', () => {
      expect(defaultRegistry.get('fix-welcome-popup-deadlock')).toBe(fixWelcomePopupDeadlock);
      expect(defaultRegistry.get('fix-iap-store-font-crash')).toBeUndefined();
      expect(() => createRegistry([fixWelcomePopupDeadlock, fixWelcomePopupDeadlock])).toThrow(PatchError);
    });
  });
}
