import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DexFile, dexNames, validateDex } from '../../src/dex';
import {
  MemoryKeystore, fixAudioFocusStall, fixBackgroundWakeup, fixSurfaceDestroyFreeze, fixTextActivityFreeze, loadApk, musicWithOtherApps, patchApk,
  LIFECYCLE_CLASS, WAKE_METHOD, type Patch, type PatchContext,
} from '../../src';
import { getEntry } from '../../src/zip';
import { haveApk } from '../helpers';

const dl = join(homedir(), 'Downloads');
const APKS: [string, string][] = [['1.7.4', 'The Blockheads_1.7.4_APKPure.apk'], ['1.7.5', 'The Blockheads_1.7.5_APKPure.apk'], ['1.7.6', 'The Blockheads_1.7.6.apk']];
const IDS = ['music-with-other-apps', 'fix-audio-focus-stall', 'fix-text-activity-freeze', 'fix-surface-destroy-freeze', 'fix-background-wakeup'];
const PATCHES: Patch[] = [musicWithOtherApps, fixAudioFocusStall, fixTextActivityFreeze, fixSurfaceDestroyFreeze, fixBackgroundWakeup];

const bt = join(homedir(), 'Android/Sdk/build-tools');
const latest = existsSync(bt) ? readdirSync(bt).sort().reverse().find((v) => existsSync(join(bt, v, 'dexdump')) && existsSync(join(bt, v, 'apksigner'))) : undefined;
const jdk = '/usr/lib/jvm/java-21-openjdk';
const platforms = join(homedir(), 'Android/Sdk/platforms');
const androidJar = existsSync(platforms) ? readdirSync(platforms).map((p) => join(platforms, p, 'android.jar')).find(existsSync) : undefined;
const d8 = latest && existsSync(join(bt, latest, 'd8')) && existsSync(jdk) && androidJar ? join(bt, latest, 'd8') : undefined;

/** The text of one method in a `dexdump -d` listing. */
const methodText = (dump: string, signature: string): string => {
  const i = dump.indexOf(`] ${signature}`);
  expect(i, signature).toBeGreaterThan(0);
  return dump.slice(i, dump.indexOf('locals', i));
};

describe.each(APKS)('real game %s: audio lifecycle patches', (version, file) => {
  const path = join(dl, file);
  const run = haveApk(path);

  it.skipIf(!run)('applies on the shipped code, output validates, dexdump shows the new code and d8 accepts it', async () => {
    const apk = await loadApk(new Uint8Array(readFileSync(path)));
    const ctx: PatchContext = { zip: apk.zip, manifest: apk.manifest, info: apk.info, markManifestDirty() {}, log() {} };
    for (const p of PATCHES) expect(p.detect(ctx), p.id).toBe('notApplied');
    for (const p of PATCHES) p.apply(ctx);
    for (const p of PATCHES) expect(p.detect(ctx), p.id).toBe('applied');
    const dir = mkdtempSync(join(tmpdir(), 'bhaud-'));
    try {
      let seen = 0;
      for (const name of dexNames(ctx.zip)) {
        const out = getEntry(ctx.zip, name)!.data;
        expect(validateDex(out), `${version} ${name}`).toEqual([]);
        const dex = DexFile.parse(out);
        if (dex.findClass(LIFECYCLE_CLASS)?.findMethod(WAKE_METHOD)) seen++;
        if (latest) {
          const f = join(dir, name);
          writeFileSync(f, out);
          const dump = execFileSync(join(bt, latest, 'dexdump'), ['-d', f], { maxBuffer: 1 << 30 }).toString();
          if (dump.includes('] com.apportable.gl.GLSurfaceView.surfaceDestroyed:()V')) {
            const sd = methodText(dump, 'com.apportable.gl.GLSurfaceView.surfaceDestroyed:()V');
            expect(sd).toContain('Landroid/os/SystemClock;.uptimeMillis');
            expect(sd).toContain('Ljava/lang/Object;.wait:(J)V');
            expect(sd).toContain('#int 250');
            const wait = methodText(dump, 'com.apportable.media.AndroidAudioManager.waitOnConnection:()V');
            expect(wait).toContain('Landroid/os/Looper;.getMainLooper');
            expect(methodText(dump, 'com.apportable.media.AndroidAudioManager.isMusicActive:()Z')).toContain('const/4 v0, #int 0');
            expect(methodText(dump, 'com.apportable.Lifecycle.testInBackground:()V')).toContain(`Lcom/apportable/Lifecycle;.${WAKE_METHOD}:()V`);
          }
        }
        if (d8) {
          const o = join(dir, `o-${name}`);
          mkdirSync(o);
          execFileSync(d8, ['--release', '--min-api', '21', '--lib', androidJar!, '--output', o, join(dir, name)], { env: { ...process.env, JAVA_HOME: jdk, PATH: `${jdk}/bin:${process.env.PATH}` }, stdio: 'pipe' });
        }
      }
      expect(seen).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!run || !latest)('signs with v1 + v2 and sets the theme on TextViewHaxActivity', async () => {
    const res = await patchApk(new Uint8Array(readFileSync(path)), { patchIds: IDS, keystore: new MemoryKeystore() });
    expect(res.applied).toEqual(IDS);
    const dir = mkdtempSync(join(tmpdir(), 'bhaud-'));
    try {
      const out = join(dir, 'p.apk');
      writeFileSync(out, res.bytes);
      const sig = spawnSync(join(bt, latest!, 'apksigner'), ['verify', '--verbose', out], { encoding: 'utf8' });
      expect(sig.stdout).toContain('v1 scheme (JAR signing): true');
      expect(sig.stdout).toContain('v2 scheme (APK Signature Scheme v2): true');
      const aapt2 = join(bt, latest!, 'aapt2');
      if (existsSync(aapt2)) {
        const xml = execFileSync(aapt2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', out], { maxBuffer: 1 << 28 }).toString();
        const i = xml.indexOf('com.apportable.ui.TextViewHaxActivity');
        const el = xml.slice(xml.lastIndexOf('E: activity', i), xml.indexOf('E: ', i));
        expect(el).toMatch(/android:theme.*=@0x01030011/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
