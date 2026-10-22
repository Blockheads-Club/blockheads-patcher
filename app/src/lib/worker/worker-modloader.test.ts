// The mod loader zip across the worker boundary: checked in the worker, re-sent to a respawned worker.
import { describe, expect, test, vi } from 'vitest';

const seen = vi.hoisted(() => ({ parsed: [] as Uint8Array[], set: [] as unknown[] }));
vi.mock('@bh-patcher/core', async (orig) => {
  const real = await orig<typeof import('@bh-patcher/core')>();
  return {
    ...real,
    loadApk: vi.fn(async () => ({ zip: {}, manifest: {}, info: { packageName: 'p', sha256: 's' } })),
    listPatches: vi.fn(() => []),
    parseModLoaderZip: vi.fn((zip: Uint8Array) => {
      if (zip.length === 0) throw new real.PatchError('mod loader: not a zip', 'modLoaderUnavailable');
      seen.parsed.push(zip);
      return { version: '0.1.0', lib: zip, dex: zip, libSha256: 'x' };
    }),
    setModLoaderArtifact: vi.fn((a: unknown) => { seen.set.push(a); })
  };
});

import type { Keystore } from '@bh-patcher/core';
import { createHandler } from './handler';
import { createWorkerEngine, type WorkerLike } from './client';
import type { Request } from './protocol';

function loopback() {
  const w: WorkerLike & { sent: Request[] } = {
    sent: [], onmessage: null, onerror: null, terminate: vi.fn(),
    postMessage(req) {
      w.sent.push(req);
      void handler(structuredClone(req));
    }
  };
  const handler = createHandler((msg) => {
    const data = structuredClone(msg);
    queueMicrotask(() => w.onmessage?.({ data }));
  });
  return w;
}
const ks: Keystore = { get: async () => ({ certificateDer: new Uint8Array([1]) }) as never, set: async () => {}, clear: async () => {} } as never;

describe('worker engine with the mod loader', () => {
  test('the zip is checked in the worker and sent again to a new worker', async () => {
    const workers = [loopback(), loopback()];
    let n = 0;
    const engine = createWorkerEngine(() => workers[n++]!, ks);
    await engine.setModLoader(new Uint8Array([1, 2]));
    expect(seen.parsed).toHaveLength(1);
    expect(seen.set).toHaveLength(1);
    workers[0]!.onerror!({ message: 'died' });
    await engine.loadApk(new Uint8Array([1]));
    expect(workers[1]!.sent.map((r) => r.t)).toEqual(['modLoader', 'load']);
    await expect(engine.setModLoader(new Uint8Array())).rejects.toMatchObject({ name: 'PatchError', code: 'modLoaderUnavailable' });
  });
});
