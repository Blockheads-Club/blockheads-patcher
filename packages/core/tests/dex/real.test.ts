import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DexFile, validateDex } from '../../src/dex';
import { fixEmailShareLink, fixWebviewCrash, loadApk, GUARD_CLASS, MAIL_FIX_CLASS, type PatchContext } from '../../src';
import { dexNames } from '../../src/dex';
import { getEntry } from '../../src/zip';
import { haveApk } from '../helpers';

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
const dump = (bytes: Uint8Array, dir: string): string => {
  const f = join(dir, 'x.dex');
  writeFileSync(f, bytes);
  return execFileSync(dexdump!, ['-d', f], { maxBuffer: 1 << 30 }).toString();
};

describe.each(APKS)('real game %s', (version, file) => {
  const path = join(dl, file);
  const run = haveApk(path);
  const ctxOf = async (): Promise<PatchContext> => {
    const apk = await loadApk(new Uint8Array(readFileSync(path)));
    return { zip: apk.zip, manifest: apk.manifest, info: apk.info, markManifestDirty() {}, log() {} };
  };

  it.skipIf(!run)('re-serializes every dex into a valid, semantically identical file', async () => {
    const ctx = await ctxOf();
    for (const name of dexNames(ctx.zip)) {
      const src = getEntry(ctx.zip, name)!.data;
      expect(validateDex(src), `${version} ${name} (input)`).toEqual([]);
      const out = DexFile.parse(src).serialize();
      expect(validateDex(out), `${version} ${name}`).toEqual([]);
      if (dexdump) {
        const dir = mkdtempSync(join(tmpdir(), 'bhdex-'));
        try { expect(norm(dump(out, dir))).toBe(norm(dump(src, dir))); } finally { rmSync(dir, { recursive: true, force: true }); }
      }
    }
  });

  it.skipIf(!run)('applies both dex patches; output validates, dexdump parses it and d8 accepts it', async () => {
    const ctx = await ctxOf();
    expect(fixWebviewCrash.detect(ctx)).toBe('notApplied');
    expect(fixEmailShareLink.detect(ctx)).toBe('notApplied');
    fixWebviewCrash.apply(ctx);
    fixEmailShareLink.apply(ctx);
    expect(fixWebviewCrash.detect(ctx)).toBe('applied');
    expect(fixEmailShareLink.detect(ctx)).toBe('applied');
    const dir = mkdtempSync(join(tmpdir(), 'bhdex-'));
    try {
      let guard = false, mail = false;
      for (const name of dexNames(ctx.zip)) {
        const out = getEntry(ctx.zip, name)!.data;
        expect(validateDex(out), `${version} ${name}`).toEqual([]);
        const dex = DexFile.parse(out);
        guard ||= !!dex.findClass(GUARD_CLASS);
        mail ||= !!dex.findClass(MAIL_FIX_CLASS);
        if (dexdump) expect(dump(out, dir)).toContain('onRenderProcessGone');
        if (d8) {
          const f = join(dir, `${name}`), o = join(dir, `o-${name}`);
          writeFileSync(f, out);
          execFileSync(d8, ['--release', '--min-api', '21', '--lib', androidJar!, '--output', (execFileSync('mkdir', ['-p', o]), o), f], { env: { ...process.env, JAVA_HOME: jdk, PATH: `${jdk}/bin:${process.env.PATH}` }, stdio: 'pipe' });
        }
      }
      expect(guard && mail).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
