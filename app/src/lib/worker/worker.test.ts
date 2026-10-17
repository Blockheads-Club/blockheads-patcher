// Drives the real handler + client through an in-process loopback "worker" (structured-clone round trip).
import { describe, expect, test, vi, beforeEach } from 'vitest';

const core = vi.hoisted(() => ({ loadCalls: 0, failReparseAfter: Infinity, patchMode: 'ok' as string }));

vi.mock('@bh-patcher/core', async (orig) => {
  const real = await orig<typeof import('@bh-patcher/core')>();
  return {
    ...real,
    loadApk: vi.fn(async (bytes: Uint8Array) => {
      core.loadCalls++;
      if (bytes.length === 0) throw new real.PatchError('not an APK: empty', 'notApk', { message: 'empty' });
      if (core.loadCalls > core.failReparseAfter) throw new Error('reparse failed');
      return { zip: {}, manifest: {}, info: { packageName: 'p', sha256: 's' } };
    }),
    listPatches: vi.fn(() => {
      const [a, b] = real.defaultRegistry.list();
      return [
        { patch: a!, status: 'notApplied' },
        { patch: b!, status: 'incompatible', reason: 'nope', reasonCode: { code: 'wrongPackage', params: { actual: 'x', expected: 'y' } } }
      ];
    }),
    patchLoadedApk: vi.fn(async (_apk: unknown, opts: { onProgress?: (s: string, f: number) => void; signal?: AbortSignal }) => {
      opts.onProgress?.('sign', 0.5);
      const mk = (bytes: Uint8Array) => ({ bytes, applied: ['a'], skipped: [], info: { packageName: 'p', sha256: 's' }, certSha256: 'c', suggestedFileName: 'o.apk' });
      switch (core.patchMode) {
        case 'fail': throw new Error('boom');
        case 'string': throw 'plain string'; // eslint-disable-line no-throw-literal
        case 'patcherr': throw new real.PatchError('cannot', 'cannotApply', { patch: 'x' });
        case 'wait':
          await new Promise<void>((_, rej) => opts.signal!.addEventListener('abort', () => rej(new real.CancelledError())));
          throw new Error('unreachable');
        case 'view': return mk(new Uint8Array(new ArrayBuffer(10), 2, 4).fill(7));
        default: return mk(new Uint8Array([1, 2, 3]));
      }
    })
  };
});

import { CancelledError, PatchError, defaultRegistry, type Keystore } from '@bh-patcher/core';
import { createHandler } from './handler';
import { createWorkerEngine, type WorkerLike } from './client';
import type { Request, Response } from './protocol';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function loopback() {
  const w: WorkerLike & { handler: ReturnType<typeof createHandler>; sent: Request[] } = {
    sent: [],
    onmessage: null,
    onerror: null,
    terminate: vi.fn(),
    handler: createHandler((msg, transfer) => {
      const data = structuredClone(msg, transfer ? { transfer } : undefined);
      queueMicrotask(() => w.onmessage?.({ data }));
    }),
    postMessage(req, transfer) {
      w.sent.push(req);
      void w.handler(structuredClone(req, transfer ? { transfer } : undefined));
    }
  };
  return w;
}

function setup(worker = loopback()) {
  const spawn = vi.fn(() => worker);
  const ks: Keystore = { get: async () => ({ certificateDer: new Uint8Array([1]) }) as never, set: async () => {}, clear: async () => {} } as never;
  return { worker, spawn, engine: createWorkerEngine(spawn, ks), ks };
}
const bytes = () => new Uint8Array([80, 75, 3, 4]);

beforeEach(() => { core.loadCalls = 0; core.failReparseAfter = Infinity; core.patchMode = 'ok'; });

describe('worker engine', () => {
  test('load maps the report back onto registry patches', async () => {
    const { engine } = setup();
    const apk = await engine.loadApk(bytes());
    expect(apk.info.packageName).toBe('p');
    const report = engine.listPatches(apk);
    expect(report[0]!.patch).toBe(defaultRegistry.list()[0]);
    expect(report[0]!.status).toBe('notApplied');
    expect(report[0]!.reason).toBeUndefined();
    expect(report[1]).toMatchObject({ status: 'incompatible', reason: 'nope', reasonCode: { code: 'wrongPackage' } });
  });

  test('transfers exact buffers and copies views / shared buffers', async () => {
    const { engine, worker } = setup();
    const exact = bytes();
    await engine.loadApk(exact);
    expect(exact.byteLength).toBe(0); // transferred (detached)
    const buf = new Uint8Array(8);
    const view = buf.subarray(2, 6);
    await engine.loadApk(view);
    expect(view.byteLength).toBe(4); // copied, caller keeps its data
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    await engine.loadApk(shared);
    expect(shared.byteLength).toBe(4);
    expect(worker.sent.filter((r) => r.t === 'load')).toHaveLength(3);
  });

  test('patch returns bytes, reports progress and consumes the handle', async () => {
    const { engine } = setup();
    const apk = await engine.loadApk(bytes());
    const progress: [string, number][] = [];
    const r = await engine.patchLoaded(apk, { patchIds: ['a'], onProgress: (s, f) => progress.push([s, f]) });
    expect(Array.from(r.bytes)).toEqual([1, 2, 3]);
    expect(r).toMatchObject({ applied: ['a'], certSha256: 'c', suggestedFileName: 'o.apk' });
    expect(progress).toEqual([['sign', 0.5]]);
    await expect(engine.patchLoaded(apk, { patchIds: ['a'] })).rejects.toThrow('unknown APK handle');
  });

  test('a byte view result is sliced before transfer', async () => {
    core.patchMode = 'view';
    const { engine } = setup();
    const r = await engine.patchLoaded(await engine.loadApk(bytes()), { patchIds: ['a'] });
    expect(Array.from(r.bytes)).toEqual([7, 7, 7, 7]);
  });

  test('failure keeps the handle usable and reload refreshes the report', async () => {
    const { engine } = setup();
    const apk = await engine.loadApk(bytes());
    core.patchMode = 'fail';
    await expect(engine.patchLoaded(apk, { patchIds: ['a'] })).rejects.toThrow('boom');
    core.patchMode = 'ok';
    expect(await engine.reload!(apk)).toBe(apk);
    expect(engine.listPatches(apk)).toHaveLength(2);
    await expect(engine.patchLoaded(apk, { patchIds: ['a'] })).resolves.toBeTruthy();
  });

  test('non-Error throws and PatchErrors cross the boundary', async () => {
    const { engine } = setup();
    let apk = await engine.loadApk(bytes());
    core.patchMode = 'string';
    await expect(engine.patchLoaded(apk, { patchIds: [] })).rejects.toThrow('plain string');
    core.patchMode = 'patcherr';
    apk = await engine.loadApk(bytes());
    const e = await engine.patchLoaded(apk, { patchIds: [] }).catch((x) => x);
    expect(e).toBeInstanceOf(PatchError);
    expect(e).toMatchObject({ code: 'cannotApply', params: { message: 'cannot', patch: 'x' } });
    const le = await engine.loadApk(new Uint8Array(0)).catch((x) => x);
    expect(le).toMatchObject({ name: 'PatchError', code: 'notApk' });
  });

  test('if re-parsing after a failure fails too, the handle is dropped', async () => {
    const { engine } = setup();
    const apk = await engine.loadApk(bytes());
    core.patchMode = 'fail';
    core.failReparseAfter = core.loadCalls; // every later parse fails
    await expect(engine.patchLoaded(apk, { patchIds: [] })).rejects.toThrow('boom');
    await expect(engine.reload!(apk)).rejects.toThrow('reparse failed');
    await expect(engine.reload!(apk)).rejects.toThrow('unknown APK handle');
  });

  test('a failure triggers exactly one re-parse, shared by reload and the next patch', async () => {
    const { engine } = setup();
    const apk = await engine.loadApk(bytes());
    core.patchMode = 'fail';
    await expect(engine.patchLoaded(apk, { patchIds: [] })).rejects.toThrow('boom');
    const afterFail = core.loadCalls;
    await engine.reload!(apk);
    await engine.reload!(apk); // clean: no further parse
    expect(core.loadCalls).toBe(afterFail + 1);
    core.patchMode = 'fail';
    await expect(engine.patchLoaded(apk, { patchIds: [] })).rejects.toThrow('boom');
    core.patchMode = 'ok';
    await engine.patchLoaded(apk, { patchIds: ['a'] }); // restores lazily without a reload
    expect(core.loadCalls).toBe(afterFail + 2);
  });

  test('cancel aborts a running patch; handle stays usable', async () => {
    core.patchMode = 'wait';
    const { engine } = setup();
    const apk = await engine.loadApk(bytes());
    const ac = new AbortController();
    const p = engine.patchLoaded(apk, { patchIds: ['a'], signal: ac.signal });
    await flush();
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    core.patchMode = 'ok';
    await engine.reload!(apk);
    await expect(engine.patchLoaded(apk, { patchIds: ['a'] })).resolves.toBeTruthy();
  });

  test('an already aborted signal never reaches the worker', async () => {
    const { engine, worker } = setup();
    const apk = await engine.loadApk(bytes());
    const ac = new AbortController();
    ac.abort();
    await expect(engine.patchLoaded(apk, { patchIds: ['a'], signal: ac.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(worker.sent.some((r) => r.t === 'patch')).toBe(false);
  });

  test('abort while the identity is being resolved', async () => {
    const { worker, spawn } = setup();
    const ac = new AbortController();
    const ks = { get: async () => { ac.abort(); return { certificateDer: new Uint8Array([1]) }; }, set: async () => {}, clear: async () => {} } as never;
    const engine = createWorkerEngine(spawn, ks);
    const apk = await engine.loadApk(bytes());
    await expect(engine.patchLoaded(apk, { patchIds: ['a'], signal: ac.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(worker.sent.some((r) => r.t === 'patch')).toBe(false);
  });

  test('patchApk loads, patches and releases', async () => {
    const { engine, worker } = setup();
    const r = await engine.patchApk(bytes(), { patchIds: ['a'] });
    expect(r.applied).toEqual(['a']);
    expect(worker.sent.map((x) => x.t)).toEqual(['load', 'patch', 'release']);
    core.patchMode = 'fail';
    await expect(engine.patchApk(bytes(), { patchIds: ['a'] })).rejects.toThrow('boom');
  });

  test('release / unknown handles / foreign objects', async () => {
    const { engine, worker } = setup();
    const apk = await engine.loadApk(bytes());
    engine.release!(apk);
    engine.release!({} as never); // not ours: ignored
    expect(worker.sent.filter((r) => r.t === 'release')).toHaveLength(1);
    await worker.handler({ t: 'release', handle: 999 });
    await worker.handler({ t: 'cancel', id: 999 });
    expect(() => engine.listPatches({} as never)).toThrow('not loaded by this engine');
  });

  test('worker errors reject pending requests and the worker is respawned', async () => {
    const w1 = loopback();
    w1.postMessage = () => {}; // swallow: request stays pending
    const w2 = loopback();
    const spawn = vi.fn().mockReturnValueOnce(w1).mockReturnValue(w2);
    const engine = createWorkerEngine(spawn, { get: async () => ({}), set: async () => {}, clear: async () => {} } as never);
    const p = engine.loadApk(bytes());
    w1.onerror!({ message: 'crash' });
    await expect(p).rejects.toThrow('crash');
    expect(w1.terminate).toHaveBeenCalled();
    w1.onerror!({}); // stale second error: worker already gone, default message
    await engine.loadApk(bytes());
    expect(spawn).toHaveBeenCalledTimes(2);
    const q = engine.loadApk(bytes());
    w2.onerror!({});
    await expect(q).rejects.toThrow('worker failed');
  });

  test('abort or release after the worker died do not throw', async () => {
    const { engine, worker } = setup();
    const apk = await engine.loadApk(bytes());
    core.patchMode = 'wait';
    const ac = new AbortController();
    const p = engine.patchLoaded(apk, { patchIds: ['a'], signal: ac.signal });
    await flush();
    worker.onerror!({ message: 'dead' });
    ac.abort(); // listener still attached for this tick; worker is gone
    await expect(p).rejects.toThrow('dead');
    engine.release!(apk);
    const apk2 = await engine.loadApk(bytes()); // respawned (same loopback object)
    worker.onerror!({ message: 'dead' });
    await expect(engine.patchApk(apk2 as never, { patchIds: [] })).rejects.toBeTruthy();
  });

  test('handles from a dead worker are stale; messageerror fails pending requests', async () => {
    const { engine, worker } = setup();
    const apk = await engine.loadApk(bytes());
    worker.onerror!({ message: 'oom' });
    await engine.loadApk(bytes()); // new worker generation reuses handle number 1
    await expect(engine.patchLoaded(apk, { patchIds: ['a'] })).rejects.toThrow('stale');
    expect(() => engine.listPatches(apk)).toThrow('stale');
    const sent = worker.sent.length;
    engine.release!(apk); // stale: nothing is posted
    expect(worker.sent.length).toBe(sent);
    const w = loopback();
    w.postMessage = () => {};
    const e2 = createWorkerEngine(() => w, { get: async () => ({}), set: async () => {}, clear: async () => {} } as never);
    const p = e2.loadApk(bytes());
    w.onmessageerror!();
    await expect(p).rejects.toThrow('deserialized');
  });

  test('stray messages and raw wire errors', async () => {
    const { engine, worker } = setup();
    const apk = await engine.loadApk(bytes());
    worker.onmessage!({ data: { t: 'progress', id: 12345, stage: 'sign', fraction: 1 } as Response }); // no pending: ignored
    // progress for a request without an onProgress callback
    await engine.patchLoaded(apk, { patchIds: ['a'] });
    // PatchError without params, and a custom error name
    worker.postMessage = (req) => {
      const err = req.t === 'load'
        ? { name: 'PatchError', message: 'm', code: 'noManifest' }
        : { name: 'TypeError', message: 'tt' };
      queueMicrotask(() => worker.onmessage!({ data: { t: 'error', id: (req as { id: number }).id, error: err } }));
    };
    const e1 = await engine.loadApk(bytes()).catch((x) => x);
    expect(e1).toBeInstanceOf(PatchError);
    expect(e1.code).toBe('noManifest');
    const e2 = await engine.reload!({ info: {} } as never).catch((x) => x);
    expect(e2.message).toContain('not loaded');
  });

  test('postMessage throwing rejects the request', async () => {
    const w = loopback();
    w.postMessage = () => { throw new Error('clone failed'); };
    const { engine } = setup(w);
    await expect(engine.loadApk(bytes())).rejects.toThrow('clone failed');
  });

  test('identity helpers delegate to core', async () => {
    const { engine } = setup();
    expect(await engine.getOrCreateIdentity()).toBeTruthy();
    const id = await engine.generateIdentity();
    const json = await engine.exportIdentityJson(id);
    expect((await engine.importIdentity(json)).certificateDer.length).toBe(id.certificateDer.length);
    expect(JSON.parse(await engine.exportIdentityEncryptedJson(id, 'pw')).version).toBe(2);
  });
});
