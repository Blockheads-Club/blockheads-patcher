// Test helpers: mock engine and platform (no dependency on the real core pipeline).
import { vi } from 'vitest';
import { buildPackArchive } from '@bh-patcher/core';
import type { Engine } from './engine';
import type { PlatformAdapter } from './platform/types';

export function mockPatchReport(status: 'applied' | 'notApplied' | 'incompatible' = 'notApplied') {
  return [{
    patch: {
      id: 'fix-welcome-popup-deadlock', version: 1,
      nameKey: 'patch.fix-welcome-popup-deadlock.name', descriptionKey: 'patch.fix-welcome-popup-deadlock.description',
      appliesTo: { packageName: 'com.noodlecake.blockheads' }, detect: () => status, apply: () => {}
    },
    status
  }] as never;
}

export function mockEngine(over: Partial<Engine> = {}): Engine {
  let id: unknown = null;
  return {
    keystore: { get: vi.fn(async () => id), set: vi.fn(async (v) => { id = v; }), clear: vi.fn(async () => { id = null; }) } as never,
    loadApk: vi.fn(async () => ({ zip: {}, manifest: {}, info: { packageName: 'com.noodlecake.blockheads', versionName: '1.7.4', versionCode: 1548230154, sha256: 'ab'.repeat(32) } })) as never,
    listPatches: vi.fn(() => mockPatchReport()),
    patchApk: vi.fn(async (_i, opts) => {
      opts.onProgress?.('sign', 0.5);
      return { bytes: new Uint8Array([1, 2, 3]), applied: [...opts.patchIds], skipped: [], info: {}, certSha256: 'cc'.repeat(32), suggestedFileName: 'blockheads-1.7.4-patched.apk' };
    }) as never,
    patchLoaded: vi.fn(async (_a, opts) => {
      opts.onProgress?.('sign', 0.5);
      return { bytes: new Uint8Array([1, 2, 3]), applied: [...opts.patchIds], skipped: [], info: {}, certSha256: 'cc'.repeat(32), suggestedFileName: 'blockheads-1.7.4-patched.apk' };
    }) as never,
    setPacks: vi.fn(async () => {}),
    getOrCreateIdentity: vi.fn(async () => {
      if (!id) id = { certificateDer: new Uint8Array([9, 9]) };
      return id as never;
    }),
    generateIdentity: vi.fn(async () => ({ certificateDer: new Uint8Array([9, 9]) })) as never,
    exportIdentityJson: vi.fn(async () => '{"version":1}'),
    exportIdentityEncryptedJson: vi.fn(async () => '{"version":2}'),
    importIdentity: vi.fn(async (j: string, _p?: string) => { if (!j.includes('version')) throw new Error('bad key'); return { certificateDer: new Uint8Array([7]) } as never; }),
    ...over
  };
}

export function mockPlatform(over: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    kind: 'web',
    pickApk: vi.fn(async () => null),
    saveOutput: vi.fn(async () => ({})),
    ...over
  };
}

export const apkFile = (name = 'game.apk') => new File([new Uint8Array([80, 75, 3, 4])], name);

/** A valid .bhpack with `patches` harmless patches (ids `pack:<id>/p0`, ...). */
export function packBytes(id = 'demo', patches = 1, over: Record<string, unknown> = {}): Uint8Array {
  const json = {
    schemaVersion: 1, id, version: '1.0.0', name: { en: `Pack ${id}`, tr: `Paket ${id}` }, appliesTo: { packageName: 'com.noodlecake.blockheads' },
    patches: Array.from({ length: patches }, (_, i) => ({
      id: `p${i}`, name: { en: `Patch ${i}`, tr: `Yama ${i}` }, description: { en: `Does ${i}` },
      ops: [{ op: 'manifest.set', target: 'application', attr: 'label', value: `L${i}` }]
    })),
    ...over
  };
  return buildPackArchive({ 'pack.json': new TextEncoder().encode(JSON.stringify(json)) });
}
