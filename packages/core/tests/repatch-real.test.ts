import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryKeystore, generateIdentity, listPatches, loadApk, parseModLoaderZip, patchApk, setModLoaderArtifact } from '../src';
import { REAL_APKS, haveApk } from './helpers';

// A game patched by an earlier Patcher (loader 0.3.0, no fix-surface-wait-deadlock) must offer the newer patches
// again, and a game patched by the current Patcher must still be re-patchable (re-sign path).
const path = REAL_APKS['1.7.6'];
const loaderZip = (v: string) => new Uint8Array(readFileSync(join(__dirname, '../../../app/static/mod-loader', `bhmod-android-loader-${v}.zip`)));
afterEach(() => setModLoaderArtifact(null));

describe.skipIf(!haveApk(path))('re-patching an already patched real game', () => {
  it('older patched: new patches and the newer loader are notApplied; current patched: everything applied', async () => {
    const ks = new MemoryKeystore();
    await ks.set(await generateIdentity());
    const input = new Uint8Array(readFileSync(path));
    const ids = listPatches(await loadApk(input)).filter((r) => r.status === 'notApplied' && !r.patch.optIn).map((r) => r.patch.id);
    expect(ids).toContain('fix-surface-wait-deadlock');

    // an earlier Patcher: loader 0.3.0 and no surface-wait fix
    setModLoaderArtifact(parseModLoaderZip(loaderZip('0.3.0'), null));
    const old = await patchApk(input, { patchIds: [...ids.filter((i) => i !== 'fix-surface-wait-deadlock')], keystore: ks });
    expect(old.skipped).toEqual([]);

    // the app lists patches before it has loaded any loader build
    setModLoaderArtifact(null);
    const oldReport = listPatches(await loadApk(old.bytes));
    const open = (r: typeof oldReport) => r.filter((x) => x.status === 'notApplied').map((x) => x.patch.id);
    expect(open(oldReport)).toContain('fix-surface-wait-deadlock');
    expect(open(oldReport)).toContain('mod-loader');

    // the current Patcher
    setModLoaderArtifact(parseModLoaderZip(loaderZip('0.3.1')));
    const cur = await patchApk(old.bytes, { patchIds: open(oldReport), keystore: ks });
    expect(cur.skipped).toEqual([]);
    setModLoaderArtifact(null);
    const curReport = listPatches(await loadApk(cur.bytes));
    expect(open(curReport).filter((i) => !curReport.find((r) => r.patch.id === i)!.patch.optIn)).toEqual([]);

    // nothing left to apply: re-signing still gives an installable APK, signed with the same key
    const again = await patchApk(cur.bytes, { patchIds: [], keystore: ks });
    expect(again.applied).toEqual([]);
    expect(again.certSha256).toBe(cur.certSha256);
    expect(again.bytes.length).toBeGreaterThan(1_000_000);
  }, 600_000);
});
