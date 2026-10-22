import { afterEach, describe, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@bh-patcher/core', async (orig) => ({
  ...(await orig<typeof import('@bh-patcher/core')>()),
  loadApk: vi.fn(async () => { core.calls.push('load'); return { info: {} }; }),
  listPatches: vi.fn(() => { core.calls.push('list'); return []; }),
  patchApk: vi.fn(async (_i: unknown, o: { keystore: unknown }) => { core.calls.push('patchApk'); return { ks: o.keystore }; }),
  patchLoadedApk: vi.fn(async (_a: unknown, o: { keystore: unknown }) => { core.calls.push('patchLoaded'); return { ks: o.keystore }; }),
  parseModLoaderZip: vi.fn(() => { core.calls.push('parseModLoader'); return { version: 'v' }; }),
  setModLoaderArtifact: vi.fn(() => { core.calls.push('setModLoader'); })
}));

import { certFingerprint, createEngine, createInlineEngine } from './engine';
import { MemoryKeystore } from '@bh-patcher/core';

afterEach(() => vi.unstubAllGlobals());

describe('engines', () => {
  test('inline engine delegates to core with its keystore', async () => {
    const ks = new MemoryKeystore();
    const e = createInlineEngine(ks);
    await e.loadApk(new Uint8Array(1));
    e.listPatches({} as never);
    expect(((await e.patchApk(new Uint8Array(1), { patchIds: [] })) as never as { ks: unknown }).ks).toBe(ks);
    expect(((await e.patchLoaded({} as never, { patchIds: [] })) as never as { ks: unknown }).ks).toBe(ks);
    expect(core.calls).toEqual(['load', 'list', 'patchApk', 'patchLoaded']);
    expect(e.reload).toBeUndefined();
    const id = await e.getOrCreateIdentity();
    expect(await e.generateIdentity()).not.toBe(id);
    expect(JSON.parse(await e.exportIdentityJson(id)).version).toBe(1);
    await e.setModLoader(new Uint8Array(1));
    expect(core.calls.slice(-2)).toEqual(['parseModLoader', 'setModLoader']);
  });

  test('createEngine uses the inline engine without Worker support', () => {
    vi.stubGlobal('Worker', undefined);
    expect(createEngine(new MemoryKeystore()).reload).toBeUndefined();
  });

  test('createEngine uses the worker engine when Workers exist', () => {
    vi.stubGlobal('Worker', class {});
    expect(createEngine(new MemoryKeystore()).reload).toBeTypeOf('function');
  });

  test('certFingerprint formats a colon separated SHA-256', async () => {
    expect(await certFingerprint(new Uint8Array([1, 2, 3]))).toMatch(/^([0-9a-f]{2}:){31}[0-9a-f]{2}$/);
  });
});
