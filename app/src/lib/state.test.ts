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
    const engine = mockEngine({ listPatches: vi.fn(() => mockPatchReport('applied')) });
    const s = new PatcherState(mockPlatform(), engine);
    expect(s.step).toBe(1);
    await s.run(); // nothing loaded
    expect(s.stage).toBe('idle');
    await s.load(picked());
    expect(s.step).toBe(2);
    await s.run(); // nothing selected
    expect(s.stage).toBe('loaded');
    s.stage = 'patching'; expect(s.step).toBe(3);
    s.stage = 'done'; expect(s.step).toBe(4);
    s.stage = 'error'; expect(s.step).toBe(2);
    s.loaded = null; expect(s.step).toBe(1);
  });
});
