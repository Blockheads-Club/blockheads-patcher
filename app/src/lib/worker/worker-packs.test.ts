// Imported packs across the worker boundary: the client keeps its own registry, every worker gets the pack files.
import { describe, expect, test, vi } from 'vitest';

const seen = vi.hoisted(() => ({ registries: [] as unknown[] }));
vi.mock('@bh-patcher/core', async (orig) => {
  const real = await orig<typeof import('@bh-patcher/core')>();
  return {
    ...real,
    loadApk: vi.fn(async () => ({ zip: {}, manifest: {}, info: { packageName: 'p', sha256: 's' } })),
    listPatches: vi.fn((_apk: unknown, registry: import('@bh-patcher/core').PatchRegistry) =>
      registry.list().filter((p) => p.source).map((patch) => ({ patch, status: 'notApplied' }))),
    patchLoadedApk: vi.fn(async (_apk: unknown, opts: { registry: unknown }) => {
      seen.registries.push(opts.registry);
      return { bytes: new Uint8Array([1]), applied: [], skipped: [], info: { packageName: 'p', sha256: 's' }, certSha256: 'c', suggestedFileName: 'o.apk' };
    })
  };
});

import { loadPack, type Keystore } from '@bh-patcher/core';
import { packBytes } from '$lib/testing';
import { createHandler } from './handler';
import { createWorkerEngine, type WorkerLike } from './client';
import type { Request } from './protocol';

const enc = new TextEncoder();
const loaded = (bytes: Uint8Array) => {
  const r = loadPack(bytes);
  if (!r.ok) throw new Error('bad test pack');
  return { pack: r.pack, bytes };
};

function loopback() {
  const w: WorkerLike & { sent: Request[]; errors: unknown[] } = {
    sent: [], errors: [],
    onmessage: null, onerror: null, terminate: vi.fn(),
    postMessage(req) {
      w.sent.push(req);
      void handler(structuredClone(req));
    }
  };
  const handler = createHandler((msg) => {
    if (msg.t === 'error') w.errors.push(msg.error);
    const data = structuredClone(msg);
    queueMicrotask(() => w.onmessage?.({ data }));
  });
  return w;
}
const ks: Keystore = { get: async () => ({ certificateDer: new Uint8Array([1]) }) as never, set: async () => {}, clear: async () => {} } as never;

describe('worker engine with packs', () => {
  test('packs set before the worker exists are sent when it spawns; later ones right away', async () => {
    const w = loopback();
    const engine = createWorkerEngine(() => w, ks);
    await engine.setPacks([loaded(packBytes('one'))]);
    expect(w.sent).toEqual([]);
    const apk = await engine.loadApk(new Uint8Array([1]));
    expect(w.sent.map((r) => r.t)).toEqual(['packs', 'load']);
    expect(engine.listPatches(apk).map((r) => r.patch.id)).toEqual(['pack:one/p0']);
    await engine.setPacks([loaded(packBytes('one')), loaded(packBytes('two', 2))]);
    expect(w.sent.at(-1)!.t).toBe('packs');
    await engine.reload!(apk);
    expect(engine.listPatches(apk).map((r) => r.patch.id)).toEqual(['pack:one/p0', 'pack:two/p0', 'pack:two/p1']);
    await engine.patchLoaded(apk, { patchIds: [] });
    expect((seen.registries.at(-1) as { list(): unknown[] }).list().length).toBeGreaterThan(3);
  });

  test('the worker validates the pack files again', async () => {
    const w = loopback();
    const engine = createWorkerEngine(() => w, ks);
    await engine.loadApk(new Uint8Array([1]));
    await expect(engine.setPacks([{ pack: loaded(packBytes()).pack, bytes: enc.encode('junk') }])).rejects.toThrow(/invalid pack/);
  });
});
