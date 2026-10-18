import { haveApk } from './helpers';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixIapStoreFontCrash, loadApk, listPatches, patchApk, MemoryKeystore, readZip, getEntry, defaultRegistry, createRegistry, fixWelcomePopupDeadlock, applyPatches, PatchError } from '../src/index';

const BT = join(homedir(), 'Android/Sdk/build-tools/35.0.0');
const tools = existsSync(join(BT, 'apksigner')) && existsSync(join(BT, 'aapt2')) && existsSync(join(BT, 'zipalign'));
const APKS = [
  { name: '1.7.4', path: '/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk', out: true, iap: false },
  { name: '1.7.5', path: '/home/kahverengi/Downloads/The Blockheads_1.7.5_APKPure.apk', out: false, iap: false },
  { name: '1.7.6', path: process.env.BH_APK_176 ?? '/home/kahverengi/Downloads/The Blockheads_1.7.6.apk', out: true, iap: true },
];

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });
for (const apk of APKS) {
  describe.skipIf(!haveApk(apk.path) || !tools)(`golden: patch Blockheads ${apk.name}`, () => {
    let input: Uint8Array;
    let output: Uint8Array;
    let outPath: string;
    const ks = new MemoryKeystore();
    let certSha = '';
    const ids = apk.iap ? ['fix-welcome-popup-deadlock', 'fix-iap-store-font-crash'] : ['fix-welcome-popup-deadlock'];
    const LIB = 'lib/armeabi-v7a/libApplication.so';

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
      const iapIn = apk.iap ? 'notApplied' : 'incompatible';
      expect(a.slice(0, 2).map((x) => [x.patch.id, x.status])).toEqual([['fix-welcome-popup-deadlock', 'notApplied'], ['fix-iap-store-font-crash', iapIn]]);
      // every later patch applies to the original APK (the list grows as patches are added)
      expect(a.slice(2).every((x) => x.status === 'notApplied')).toBe(true);
      expect(a.slice(2).map((x) => x.patch.id)).toEqual(expect.arrayContaining(NEW_PATCHES));
      const b = listPatches(await loadApk(output));
      expect(b[0]!.status).toBe('applied');
      expect(b[1]!.status).toBe(apk.iap ? 'applied' : 'incompatible');
    }, 120_000);

    it('second apply on patched output throws', async () => {
      const loaded = await loadApk(output);
      expect(applyPatches(loaded, ids).skipped.map((x) => x.status)).toEqual(ids.map(() => 'applied'));
      if (apk.iap) expect(() => fixIapStoreFontCrash.apply({ zip: loaded.zip, manifest: loaded.manifest, info: loaded.info, markManifestDirty() {}, log() {} })).toThrow(PatchError);
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
      const changed = (n: string) => n === 'AndroidManifest.xml' || (apk.iap && n === LIB);
      const ea = a.entries.filter((e) => !isSig(e.name) && !changed(e.name));
      const eb = b.entries.filter((e) => !isSig(e.name) && !changed(e.name));
      expect(eb.map((e) => e.name)).toEqual(ea.map((e) => e.name));
      for (let i = 0; i < ea.length; i++) {
        expect(Buffer.compare(ea[i]!.data, eb[i]!.data), ea[i]!.name).toBe(0);
        expect(eb[i]!.method, ea[i]!.name).toBe(ea[i]!.method);
      }
    });

    it.skipIf(!apk.iap)('libApplication.so: only the 4 instruction words differ', () => {
      const a = getEntry(readZip(input), LIB)!, b = getEntry(readZip(output), LIB)!;
      expect(b.data.length).toBe(a.data.length);
      const diff: number[] = [];
      for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) diff.push(i);
      const offs = [0xb79ee0, 0xb0f5cc, 0xb5d558, 0xd33974];
      expect(new Set(diff.map((d) => d & ~3))).toEqual(new Set(offs));
      for (const o of offs) {
        expect(Buffer.from(a.data.subarray(o, o + 4)).toString('hex')).toBe('f04d2de9');
        expect(Buffer.from(b.data.subarray(o, o + 4)).toString('hex')).toBe('1eff2fe1');
      }
      expect(b.method).toBe(a.method);
    });

    it('re-patching with the same keystore keeps the signing certificate', async () => {
      const again = await patchApk(input, { patchIds: ids, keystore: ks });
      expect(again.certSha256).toBe(certSha);
    }, 120_000);
  });
}

const NEW_PATCHES = ['enable-audio-capture', 'keep-data-on-uninstall', 'disable-multi-window', 'raise-target-sdk', 'fix-join-links', 'adaptive-icon'];

describe('registry', () => {
  it('default registry has both patches; duplicates rejected', () => {
    expect(defaultRegistry.get('fix-welcome-popup-deadlock')).toBe(fixWelcomePopupDeadlock);
    expect(defaultRegistry.get('fix-iap-store-font-crash')).toBe(fixIapStoreFontCrash);
    expect(() => createRegistry([fixWelcomePopupDeadlock, fixWelcomePopupDeadlock])).toThrow(PatchError);
  });
});
