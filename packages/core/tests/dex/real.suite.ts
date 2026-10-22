import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DexFile, validateDex } from '../../src/dex';
import {
  applyPatches, defaultRegistry, fixConfigChangeCrash, fixEmailShareLink, gamepadControls, GAMEPAD_CLASS, WINDOW_DIALOG_CLASS, fixWebviewCrash, IMMERSIVE_CLASS, listPatches, LOOP_GUARD_CLASS, lanMulticast, loadApk, signEditorCentred, tabletLayout, GUARD_CLASS, MAIL_FIX_CLASS, MULTICAST_CLASS, MULTICAST_PERMISSION, TABLET_CLASS,
  type PatchContext,
} from '../../src';
import { findElementsByName } from '../../src/axml';
import { dexNames } from '../../src/dex';
import { getEntry } from '../../src/zip';
import { calleeOf, insnsOf } from '../../src/patches/dex-support';
import { haveApk, yieldToRunner } from '../helpers';
import { parseModLoaderZip, setModLoaderArtifact } from '../../src';
import { fakeLoaderZip } from './mod-loader-fixture';

const dl = join(homedir(), 'Downloads');
const APKS: [string, string][] = [['1.7.4', 'The Blockheads_1.7.4_APKPure.apk'], ['1.7.5', 'The Blockheads_1.7.5_APKPure.apk'], ['1.7.6', 'The Blockheads_1.7.6.apk']];

/** Android SDK tools are optional: tests that need them are skipped when absent. */
const bt = join(homedir(), 'Android/Sdk/build-tools');
const latest = existsSync(bt) ? readdirSync(bt).sort().reverse().find((v) => existsSync(join(bt, v, 'dexdump'))) : undefined;
const dexdump = latest ? join(bt, latest, 'dexdump') : undefined;
const jdk = '/usr/lib/jvm/java-21-openjdk';
const platforms = join(homedir(), 'Android/Sdk/platforms');
const androidJar = existsSync(platforms) ? readdirSync(platforms).map((p) => join(platforms, p, 'android.jar')).find(existsSync) : undefined;
const d8 = latest && existsSync(join(bt, latest, 'd8')) && existsSync(jdk) && androidJar ? join(bt, latest, 'd8') : undefined;

const norm = (t: string): string => t.replace(/^[0-9a-f]{6}: /gm, '').replace(/\[[0-9a-f]{6}\]/g, '').replace(/^(Processing|Opened).*$/gm, '').replace(/^ +\|/gm, '|');
/** d8 compiles every edited dex file (untouched ones are the game's own; one run per file: the game repeats some classes across its dex files). */
const d8Accepts = async (dir: string, files: [string, Uint8Array][]): Promise<void> => {
  expect(files.length, 'no dex was edited').toBeGreaterThan(0);
  if (!d8) return;
  for (const [name, data] of files) {
    await yieldToRunner();
    const f = join(dir, `d8-in-${name}`), o = join(dir, `d8-out-${name}`);
    writeFileSync(f, data);
    mkdirSync(o, { recursive: true });
    execFileSync(d8, ['--release', '--min-api', '21', '--lib', androidJar!, '--output', o, f], { env: { ...process.env, JAVA_HOME: jdk, PATH: `${jdk}/bin:${process.env.PATH}` }, stdio: 'pipe' });
  }
};
const dump = (bytes: Uint8Array, dir: string): string => {
  const f = join(dir, 'x.dex');
  writeFileSync(f, bytes);
  return execFileSync(dexdump!, ['-d', f], { maxBuffer: 1 << 30 }).toString();
};

/** The suite for one game version; each version has its own test file so the versions run in parallel. */
export function realGameSuite(version: string): void {
  const file = APKS.find(([v]) => v === version)![1];
  describe(`real game ${version}`, () => {
    const path = join(dl, file);
    const run = haveApk(path);
    const ctxOf = async (): Promise<PatchContext> => {
      const apk = await loadApk(new Uint8Array(readFileSync(path)));
      return { zip: apk.zip, manifest: apk.manifest, info: apk.info, markManifestDirty() {}, log() {} };
    };

    it.skipIf(!run)('re-serializes every dex into a valid, semantically identical file', async () => {
      const ctx = await ctxOf();
      for (const name of dexNames(ctx.zip)) {
        await yieldToRunner();
        const src = getEntry(ctx.zip, name)!.data;
        expect(validateDex(src), `${version} ${name} (input)`).toEqual([]);
        await yieldToRunner();
        const out = DexFile.parse(src).serialize();
        await yieldToRunner();
        expect(validateDex(out), `${version} ${name}`).toEqual([]);
        await yieldToRunner();
        if (dexdump) {
          const dir = mkdtempSync(join(tmpdir(), 'bhdex-'));
          try { expect(norm(dump(out, dir))).toBe(norm(dump(src, dir))); } finally { rmSync(dir, { recursive: true, force: true }); }
        }
      }
    });

    it.skipIf(!run)('applies both dex patches; output validates, dexdump parses it and d8 accepts it', async () => {
      const ctx = await ctxOf();
      expect(fixWebviewCrash.detect(ctx)).toBe('notApplied');
      await yieldToRunner();
      expect(fixEmailShareLink.detect(ctx)).toBe('notApplied');
      await yieldToRunner();
      fixWebviewCrash.apply(ctx);
      await yieldToRunner();
      fixEmailShareLink.apply(ctx);
      await yieldToRunner();
      expect(fixWebviewCrash.detect(ctx)).toBe('applied');
      await yieldToRunner();
      expect(fixEmailShareLink.detect(ctx)).toBe('applied');
      await yieldToRunner();
      const dir = mkdtempSync(join(tmpdir(), 'bhdex-'));
      try {
        const edited: [string, Uint8Array][] = [];
        let guard = false, mail = false;
        for (const name of dexNames(ctx.zip)) {
          await yieldToRunner();
          const out = getEntry(ctx.zip, name)!.data;
          expect(validateDex(out), `${version} ${name}`).toEqual([]);
          const dex = DexFile.parse(out);
          guard ||= !!dex.findClass(GUARD_CLASS);
          mail ||= !!dex.findClass(MAIL_FIX_CLASS);
          if (dexdump) expect(dump(out, dir)).toContain('onRenderProcessGone');
          if (!getEntry(ctx.zip, name)!.raw) edited.push([name, out]);
        }
        await d8Accepts(dir, edited);
        expect(guard && mail).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    it.skipIf(!run)('applies fix-config-change-crash; output validates, dexdump shows the guard and the hook, d8 accepts it', async () => {
      const ctx = await ctxOf();
      expect(fixConfigChangeCrash.detect(ctx)).toBe('notApplied');
      await yieldToRunner();
      fixConfigChangeCrash.apply(ctx);
      await yieldToRunner();
      expect(fixConfigChangeCrash.detect(ctx)).toBe('applied');
      await yieldToRunner();
      const dir = mkdtempSync(join(tmpdir(), 'bhdex-'));
      try {
        const edited: [string, Uint8Array][] = [];
        const holders: string[] = [];
        for (const name of dexNames(ctx.zip)) {
          await yieldToRunner();
          const out = getEntry(ctx.zip, name)!.data;
          expect(validateDex(out), `${version} ${name}`).toEqual([]);
          const dex = DexFile.parse(out);
          if (dex.findClass(LOOP_GUARD_CLASS)) {
            holders.push(name);
            expect(dex.findClass('Lcom/apportable/activity/VerdeActivity;'), `${version} guard next to the activity`).toBeDefined();
            if (dexdump) {
              const text = dump(out, dir);
              const g = LOOP_GUARD_CLASS.slice(1, -1);
              expect(text).toMatch(new RegExp(`VerdeActivity\\.onCreate:\\(Landroid/os/Bundle;\\)V\\n\\S+: \\S+ \\S+ \\S+ +\\|0000: invoke-static \\{\\}, L${g};\\.install:\\(\\)V`));
              expect(text).toMatch(/\|0000: invoke-static \{\}, Landroid\/os\/Looper;\.loop:\(\)V[\s\S]*?\|001d: throw v0\n\s+catches\s+: 1\n\s+0x0000 - 0x0003\n\s+Ljava\/lang\/Throwable; -> 0x0004/);
            }
          }
          if (!getEntry(ctx.zip, name)!.raw) edited.push([name, out]);
        }
        await d8Accepts(dir, edited);
        expect(holders).toEqual(['classes.dex']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    it.skipIf(!run)('applies gamepad-controls; output validates, dexdump shows both hooks, d8 accepts it', async () => {
      const ctx = await ctxOf();
      expect(gamepadControls.detect(ctx)).toBe('notApplied');
      await yieldToRunner();
      gamepadControls.apply(ctx);
      await yieldToRunner();
      expect(gamepadControls.detect(ctx)).toBe('applied');
      await yieldToRunner();
      const dir = mkdtempSync(join(tmpdir(), 'bhdex-'));
      try {
        const edited: [string, Uint8Array][] = [];
        const holders: string[] = [];
        for (const name of dexNames(ctx.zip)) {
          await yieldToRunner();
          const out = getEntry(ctx.zip, name)!.data;
          expect(validateDex(out), `${version} ${name}`).toEqual([]);
          const dex = DexFile.parse(out);
          if (dex.findClass(GAMEPAD_CLASS)) {
            holders.push(name);
            expect(dex.findClass(WINDOW_DIALOG_CLASS), `${version} Gamepad next to the dialog`).toBeDefined();
            if (dexdump) {
              const text = dump(out, dir);
              const g = GAMEPAD_CLASS.slice(1, -1);
              for (const [m, p, e] of [['dispatchKeyEvent', 'Landroid/view/KeyEvent;', 'onKey'], ['onGenericMotionEvent', 'Landroid/view/MotionEvent;', 'onMotion']] as const) {
                const head = `Window\\$WindowDialog\\.${m}:\\(${p.replace(/[/$]/g, '\\$&')}\\)Z\\n\\S+: \\S+ \\S+ \\S+ +\\|0000: invoke-static \\{v\\d+, v\\d+\\}, L${g};\\.${e}:`;
                expect(text).toMatch(new RegExp(head));
              }
              expect(text).toContain(`L${g};.send:(IIFFF)V`);
            }
          }
          if (!getEntry(ctx.zip, name)!.raw) edited.push([name, out]);
        }
        await d8Accepts(dir, edited);
        expect(holders).toEqual(['classes.dex']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    it.skipIf(!run)('applies the sign, LAN and tablet patches; output validates, dexdump shows the edits and d8 accepts it', async () => {
      const ctx = await ctxOf();
      const patches = [signEditorCentred, lanMulticast, tabletLayout];
      for (const p of patches) expect(p.detect(ctx), `${version} ${p.id}`).toBe('notApplied');
      await yieldToRunner();
      for (const p of patches) p.apply(ctx);
      await yieldToRunner();
      for (const p of patches) expect(p.detect(ctx), `${version} ${p.id}`).toBe('applied');
      await yieldToRunner();
      expect(findElementsByName(ctx.manifest, 'uses-permission', MULTICAST_PERMISSION)).toHaveLength(1);
      const dir = mkdtempSync(join(tmpdir(), 'bhdex-'));
      try {
        const edited: [string, Uint8Array][] = [];
        let text = '';
        for (const name of dexNames(ctx.zip)) {
          await yieldToRunner();
          const out = getEntry(ctx.zip, name)!.data;
          expect(validateDex(out), `${version} ${name}`).toEqual([]);
          if (dexdump) text += dump(out, dir);
          if (!getEntry(ctx.zip, name)!.raw) edited.push([name, out]);
        }
        await d8Accepts(dir, edited);
        if (dexdump) {
          expect(text).toMatch(/const\/16 v1, #int 49 \/\/ #31\s+\S+: \S+ \S+ \S+\s+\|\w+: invoke-virtual \{v0, v1\}, Lcom\/apportable\/ui\/TextView\$EditText;\.setGravity/);
          for (const needle of [`${MULTICAST_CLASS.slice(1, -1)};.acquire`, `${MULTICAST_CLASS.slice(1, -1)};.release`, `${TABLET_CLASS.slice(1, -1)};.init`, `${TABLET_CLASS.slice(1, -1)};.splash`]) expect(text).toContain(needle);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    // one version is enough for the composition check (the hooks are identical in 1.7.4-1.7.6) and keeps the suite fast
    it.skipIf(!run || version !== '1.7.6')('applies every patch together (VerdeActivity and WindowDialog hooks compose); output validates and d8 accepts it', async () => {
      const apk = await loadApk(new Uint8Array(readFileSync(path)));
      // the mod loader needs its build: a synthetic one (fake library, a dex with the listener class)
      setModLoaderArtifact(parseModLoaderZip(fakeLoaderZip(), null));
      const ids = listPatches(apk).filter((r) => r.status === 'notApplied').map((r) => r.patch.id);
      expect(ids).toEqual(expect.arrayContaining(['immersive-fullscreen', 'gamepad-controls', 'fix-config-change-crash', 'mod-loader']));
      await yieldToRunner();
    const { applied, skipped } = applyPatches(apk, ids);
    await yieldToRunner();
      expect(skipped).toEqual([]);
      expect(applied).toEqual(ids);
      const after = listPatches(apk);
      for (const id of ids) expect(after.find((r) => r.patch.id === id)!.status, `${version} ${id}`).toBe('applied');
      const dir = mkdtempSync(join(tmpdir(), 'bhdex-'));
      try {
        const edited: [string, Uint8Array][] = [];
        for (const name of dexNames(apk.zip)) {
          await yieldToRunner();
          const out = getEntry(apk.zip, name)!.data;
          expect(validateDex(out), `${version} ${name}`).toEqual([]);
          const dex = DexFile.parse(out);
          const act = dex.findClass('Lcom/apportable/activity/VerdeActivity;');
          if (act) {
            const calls = (name: string, params: string[], helper: string): boolean =>
              insnsOf(act, act.findMethod(name, params, 'V')!).some((i) => calleeOf(dex, i)?.cls === helper);
            expect(calls('onCreate', ['Landroid/os/Bundle;'], LOOP_GUARD_CLASS)).toBe(true);
            expect(calls('onResume', [], MULTICAST_CLASS)).toBe(true);
            expect(calls('hideSystemUI', [], IMMERSIVE_CLASS)).toBe(true);
            expect(calls('onConfigurationChanged', ['Landroid/content/res/Configuration;'], IMMERSIVE_CLASS)).toBe(true);
          }
          const dialog = dex.findClass(WINDOW_DIALOG_CLASS);
          if (dialog) {
            const first = (name: string, param: string): string | undefined =>
              calleeOf(dex, insnsOf(dialog, dialog.findMethod(name, [param], 'Z')!)[0]!)?.cls;
            expect(first('dispatchKeyEvent', 'Landroid/view/KeyEvent;')).toBe(GAMEPAD_CLASS);
            expect(first('onGenericMotionEvent', 'Landroid/view/MotionEvent;')).toBe(GAMEPAD_CLASS);
          }
          if (!getEntry(apk.zip, name)!.raw) edited.push([name, out]);
        }
        await d8Accepts(dir, edited);
      } finally {
        setModLoaderArtifact(null);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
