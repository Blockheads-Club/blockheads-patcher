import { describe, expect, test, vi } from 'vitest';
import { PatcherState } from './state.svelte';
import { mockEngine, mockPatchReport, mockPlatform } from './testing';

const picked = () => ({ name: 'bh.apk', bytes: new Uint8Array([1]), source: 'file' as const });
const cancelled = () => Object.assign(new Error('cancelled'), { name: 'CancelledError' });

describe('PatcherState cancel and recovery', () => {
  test('cancel returns to the loaded step without an error (worker engine: reload)', async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    const reload = vi.fn(async (a) => a);
    const engine = mockEngine({
      reload: reload as never,
      patchLoaded: vi.fn((_a, opts) => new Promise((_res, rej) => {
        started();
        opts.signal!.addEventListener('abort', () => rej(cancelled()));
      })) as never
    });
    const s = new PatcherState(mockPlatform(), engine);
    await s.load(picked());
    const run = s.run();
    await running;
    expect(s.stage).toBe('patching');
    s.cancel();
    await run;
    expect(s.stage).toBe('loaded');
    expect(s.error).toBeNull();
    expect(reload).toHaveBeenCalled();
    expect(engine.loadApk).toHaveBeenCalledTimes(1); // no re-parse on the UI thread
    expect(s.loaded).not.toBeNull();
  });

  test('cancel without a running job is a no-op', () => {
    expect(() => new PatcherState(mockPlatform(), mockEngine()).cancel()).not.toThrow();
  });

  test('inline engine: failure re-parses the original bytes and reports the error', async () => {
    const engine = mockEngine({ patchLoaded: vi.fn(async () => { throw new Error('boom'); }) as never });
    const s = new PatcherState(mockPlatform(), engine);
    await s.load(picked());
    await s.run();
    expect(engine.loadApk).toHaveBeenCalledTimes(2);
    expect(s.stage).toBe('error');
    expect(s.loaded).not.toBeNull();
  });

  test('inline engine: a cancelled run re-parses and goes back to loaded', async () => {
    const engine = mockEngine({ patchLoaded: vi.fn(async () => { throw cancelled(); }) as never });
    const s = new PatcherState(mockPlatform(), engine);
    await s.load(picked());
    await s.run();
    expect(s.stage).toBe('loaded');
    expect(s.error).toBeNull();
  });

  test('if recovery fails the state falls back to idle', async () => {
    const loadApk = vi.fn()
      .mockResolvedValueOnce({ info: { packageName: 'p' } })
      .mockRejectedValueOnce(new Error('gone'));
    const engine = mockEngine({ loadApk: loadApk as never, listPatches: vi.fn(() => mockPatchReport()), patchLoaded: vi.fn(async () => { throw cancelled(); }) as never });
    const s = new PatcherState(mockPlatform(), engine);
    await s.load(picked());
    await s.run();
    expect(s.loaded).toBeNull();
    expect(s.stage).toBe('idle');
  });

  test('reset releases the worker-held archive', async () => {
    const release = vi.fn();
    const s = new PatcherState(mockPlatform(), mockEngine({ release }));
    s.reset(); // nothing loaded yet
    expect(release).not.toHaveBeenCalled();
    await s.load(picked());
    s.reset();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('PatcherState misc', () => {
  test('step per stage and run guards', async () => {
    const engine = mockEngine();
    const s = new PatcherState(mockPlatform(), engine);
    expect(s.step).toBe(1);
    await s.run(); // nothing loaded
    expect(s.stage).toBe('idle');
    await s.load(picked());
    expect(s.step).toBe(2);
    s.selected = [];
    expect(s.resignOnly).toBe(false);
    await s.run(); // nothing selected, but patches are open: the user has to pick one
    expect(s.stage).toBe('loaded');
    s.stage = 'patching'; expect(s.step).toBe(3);
    s.stage = 'done'; expect(s.step).toBe(4);
    s.stage = 'error'; expect(s.step).toBe(2);
    s.loaded = null; expect(s.step).toBe(1);
  });
});

describe('PatcherState: every patch already applied (patch again)', () => {
  test('nothing to tick, but the APK can still be rebuilt and signed with no patches', async () => {
    const engine = mockEngine({ listPatches: vi.fn(() => mockPatchReport('applied')) });
    const s = new PatcherState(mockPlatform(), engine);
    await s.load(picked());
    expect([s.selected, s.resignOnly]).toEqual([[], true]);
    await s.run();
    expect(s.stage).toBe('done');
    expect(engine.patchLoaded).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ patchIds: [] }));
    expect(s.result?.applied).toEqual([]);
  });
  test('not offered when nothing is applied (or nothing fits)', async () => {
    for (const status of ['notApplied', 'incompatible'] as const) {
      const s = new PatcherState(mockPlatform(), mockEngine({ listPatches: vi.fn(() => [...mockPatchReport(status), ...mockPatchReport('incompatible')]) }));
      await s.load(picked());
      expect(s.resignOnly).toBe(false);
    }
  });
});

describe('PatcherState load paths', () => {
  const incompatible = (code?: string) => [{ patch: { id: 'p' }, status: 'incompatible', reasonCode: code ? { code, params: {} } : undefined }] as never;

  test('all patches incompatible: unsupported version, nothing adopted, handle released', async () => {
    const release = vi.fn();
    const engine = mockEngine({ listPatches: vi.fn(() => incompatible('versionTooLow')), release });
    const s = new PatcherState(mockPlatform(), engine);
    await s.load(picked());
    expect(s.stage).toBe('idle');
    expect(s.unsupported).toMatchObject({ name: 'bh.apk', wrongPackage: false, reason: { code: 'versionTooLow' } });
    expect(release).toHaveBeenCalled();
    expect(s.loading).toBe(false);
    expect(s.pending).toBeNull();
    expect(s.log.at(-1)?.text).toContain('versionTooLow');
  });
  test('wrong package and missing reason', async () => {
    const engine = mockEngine({
      loadApk: vi.fn(async () => ({ info: { packageName: 'other.app', sha256: '' } })) as never,
      listPatches: vi.fn(() => incompatible())
    });
    const s = new PatcherState(mockPlatform(), engine);
    await s.load(picked());
    expect(s.unsupported?.wrongPackage).toBe(true);
    expect(s.log.at(-1)?.text).toContain('incompatible');
  });
  test('non-Error load failures are logged as text', async () => {
    const s = new PatcherState(mockPlatform(), mockEngine({ loadApk: vi.fn(async () => { throw 'plain text'; }) }));
    await s.load(picked());
    expect(s.log.at(-1)?.text).toBe('plain text');
  });
  test('load failure keeps the file name and logs the error', async () => {
    const s = new PatcherState(mockPlatform(), mockEngine({ loadApk: vi.fn(async () => { throw new Error('bad zip'); }) }));
    await s.load(picked());
    expect(s.stage).toBe('idle');
    expect(s.lastName).toBe('bh.apk');
    expect(s.log.at(-1)).toMatchObject({ kind: 'error', text: 'bad zip' });
    expect(s.error).toBeInstanceOf(Error);
  });
  test('success records size, log and selects applicable patches', async () => {
    const s = new PatcherState(mockPlatform(), mockEngine());
    await s.load(picked());
    expect(s.stage).toBe('loaded');
    expect(s.fileSize).toBe(1);
    expect(s.selected).toEqual(['fix-welcome-popup-deadlock']);
    expect(s.log.map((l) => l.kind)).toEqual(['read', 'detect']);
  });
  test('cancelLoad drops a result that arrives later (and releases it)', async () => {
    let resolve!: (v: unknown) => void;
    const release = vi.fn();
    const engine = mockEngine({ loadApk: vi.fn(() => new Promise((r) => { resolve = r; })) as never, release });
    const s = new PatcherState(mockPlatform(), engine);
    const p = s.load(picked());
    expect(s.pending).toEqual({ name: 'bh.apk', size: 1 });
    await vi.waitFor(() => expect(engine.loadApk).toHaveBeenCalled());
    s.cancelLoad();
    expect(s.loading).toBe(false);
    resolve({ info: { packageName: 'p' } });
    await p;
    expect(s.stage).toBe('idle');
    expect(release).toHaveBeenCalled();
  });
  test('a failure after cancelLoad is ignored', async () => {
    let reject!: (e: unknown) => void;
    const engine = mockEngine({ loadApk: vi.fn(() => new Promise((_r, rej) => { reject = rej; })) as never });
    const s = new PatcherState(mockPlatform(), engine);
    const p = s.load(picked());
    await vi.waitFor(() => expect(engine.loadApk).toHaveBeenCalled());
    s.cancelLoad();
    reject(new Error('late'));
    await p;
    expect(s.error).toBeNull();
  });
});

describe('PatcherState run, log and navigation', () => {
  test('progress transitions are logged once per stage; done fills result', async () => {
    const engine = mockEngine({
      patchLoaded: vi.fn(async (_a, opts) => {
        for (const st of ['patch', 'sign', 'sign', 'done'] as const) opts.onProgress?.(st, 1);
        return { bytes: new Uint8Array(3), applied: ['x'], skipped: [], info: {}, certSha256: 'aa', suggestedFileName: 'o.apk' };
      }) as never
    });
    const s = new PatcherState(mockPlatform(), engine);
    await s.load(picked());
    await s.run();
    expect(s.stage).toBe('done');
    expect(s.log.map((l) => l.kind)).toEqual(['read', 'detect', 'patch', 'patch', 'sign', 'done', 'done']);
  });
  test('the mod loader files are read and handed to the engine only when its patch is selected', async () => {
    const engine = mockEngine();
    const zip = new Uint8Array([9]);
    const load = vi.fn(async () => zip);
    const s = new PatcherState(mockPlatform(), engine, load);
    await s.load(picked());
    await s.run();
    expect(load).not.toHaveBeenCalled();
    await s.load(picked());
    s.selected = [...s.selected, 'mod-loader'];
    await s.run();
    expect(engine.setModLoader).toHaveBeenCalledWith(zip);
    expect(s.log.some((l) => l.text === 'mod loader files checked')).toBe(true);
    const failing = new PatcherState(mockPlatform(), mockEngine(), async () => { throw new Error('missing'); });
    await failing.load(picked());
    failing.selected = ['mod-loader'];
    await failing.run();
    expect(failing.runFailed).toBe(true);
  });
  test('the default mod loader reader fetches next to the app', async () => {
    const g = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const s = new PatcherState(mockPlatform(), mockEngine());
    await s.load(picked());
    s.selected = ['mod-loader'];
    await s.run();
    expect(s.runFailed).toBe(true);
    g.mockRestore();
  });
  test('run without a selection does nothing', async () => {
    const s = new PatcherState(mockPlatform(), mockEngine());
    await s.load(picked());
    s.selected = [];
    await s.run();
    expect(s.stage).toBe('loaded');
  });
  test('failed run sets runFailed; cancelled run does not; back and reset clear it', async () => {
    const engine = mockEngine({ patchLoaded: vi.fn(async () => { throw new Error('boom'); }) as never });
    const s = new PatcherState(mockPlatform(), engine);
    await s.load(picked());
    await s.run();
    expect(s.runFailed).toBe(true);
    expect(s.step).toBe(2);
    s.back();
    expect(s.runFailed).toBe(false);
    expect(s.stage).toBe('loaded');
    s.back();
    s.picked = null; s.loaded = null;
    s.back();
    expect(s.stage).toBe('idle');
    await s.run();
    s.runFailed = true; s.lastName = 'x';
    s.reset();
    expect(s.runFailed).toBe(false);
    expect(s.lastName).toBeNull();
  });
  test('cancel is logged', async () => {
    const engine = mockEngine({ patchLoaded: vi.fn(async () => { throw cancelled(); }) as never });
    const s = new PatcherState(mockPlatform(), engine);
    await s.load(picked());
    await s.run();
    expect(s.log.at(-1)?.kind).toBe('cancel');
    expect(s.runFailed).toBe(false);
  });
  test('reset releases a loaded archive', async () => {
    const release = vi.fn();
    const s = new PatcherState(mockPlatform(), mockEngine({ release }));
    await s.load(picked());
    s.reset();
    expect(release).toHaveBeenCalled();
  });
});
