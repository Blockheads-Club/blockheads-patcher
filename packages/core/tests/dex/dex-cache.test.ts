import { describe, it, expect } from 'vitest';
import { createRegistry, listPatches, loadApk, type Patch, type PatchContext } from '../../src/index';
import { openDexSet } from '../../src/patches/dex-support';
import type { DexSet } from '../../src/dex';
import { makeApk, BLOCKHEADS } from '../synthetic-apk';
import { richDex } from './samples';

const probe = (id: string, fn: (set: DexSet | undefined, ctx: PatchContext) => void): Patch => ({
  id, version: 1, nameKey: id, descriptionKey: id, appliesTo: { packageName: BLOCKHEADS },
  detect(ctx) { fn(openDexSet(ctx), ctx); return 'notApplied'; },
  apply() {},
});

describe('listPatches shares parsed dex files between detects', () => {
  it('parses once while detects only read, re-parses after a detect changed the pools', async () => {
    const apk = await loadApk(makeApk({}, [{ name: 'classes.dex', data: richDex(), method: 8 }]));
    const seen: (DexSet | undefined)[] = [];
    const reg = createRegistry([
      probe('a', (s) => seen.push(s)),
      probe('b', (s) => { seen.push(s); s!.get('classes.dex').string('added by a detect'); }),
      probe('c', (s) => seen.push(s)),
      probe('d', (s) => seen.push(s)),
    ]);
    expect(listPatches(apk, reg).map((r) => r.status)).toEqual(['notApplied', 'notApplied', 'notApplied', 'notApplied']);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[1]);
    expect(seen[2]!.get('classes.dex').strings.length).toBe(seen[0]!.get('classes.dex').strings.length - 1);
    expect(seen[3]).toBe(seen[2]);
  });

  it('caches the absence of usable dex files too', async () => {
    const apk = await loadApk(makeApk());
    const seen: (DexSet | undefined)[] = [];
    const reg = createRegistry([probe('a', (s) => seen.push(s)), probe('b', (s) => seen.push(s))]);
    listPatches(apk, reg);
    expect(seen).toEqual([undefined, undefined]);
  });

  it('applyPatches contexts parse afresh', async () => {
    const apk = await loadApk(makeApk({}, [{ name: 'classes.dex', data: richDex(), method: 8 }]));
    const ctx: PatchContext = { zip: apk.zip, manifest: apk.manifest, info: apk.info, markManifestDirty() {}, log() {} };
    expect(openDexSet(ctx)).not.toBe(openDexSet(ctx));
  });
});
