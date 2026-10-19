import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { defaultRegistry } from '@bh-patcher/core';
import { Boot, bootWork, SLOW_MS } from './boot.svelte';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('bootWork loads the patch list and the signing key', async () => {
  const refresh = vi.fn(async () => {});
  await bootWork({ refresh });
  expect(refresh).toHaveBeenCalled();
});

test('bootWork loads the imported packs and tolerates a broken pack store', async () => {
  const init = vi.fn(async () => {});
  await bootWork({ refresh: async () => {} }, { init });
  expect(init).toHaveBeenCalled();
  await expect(bootWork({ refresh: async () => {} }, { init: async () => { throw new Error('fs'); } })).resolves.toBeUndefined();
});

test('bootWork tolerates an unreadable key store but not a missing patch list', async () => {
  await expect(bootWork({ refresh: async () => { throw new Error('idb'); } })).resolves.toBeUndefined();
  vi.spyOn(defaultRegistry, 'list').mockReturnValue([]);
  await expect(bootWork({ refresh: async () => {} })).rejects.toThrow('empty');
});

test('a quick boot goes loading -> ready without the slow state', async () => {
  const b = new Boot(async () => {});
  const run = b.run();
  expect(b.phase).toBe('loading');
  await run;
  expect(b.phase).toBe('ready');
  await vi.advanceTimersByTimeAsync(SLOW_MS * 2);
  expect(b.phase).toBe('ready');
});

test('a long boot turns slow, then ready', async () => {
  let done: () => void = () => {};
  const b = new Boot(() => new Promise<void>((r) => { done = r; }), 1000);
  const run = b.run();
  await vi.advanceTimersByTimeAsync(999);
  expect(b.phase).toBe('loading');
  await vi.advanceTimersByTimeAsync(1);
  expect(b.phase).toBe('slow');
  done();
  await run;
  expect(b.phase).toBe('ready');
});

test('failures show the error, retry runs again, and a stale run cannot overwrite a newer one', async () => {
  const work = vi.fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('no list'))
    .mockRejectedValueOnce('plain text')
    .mockResolvedValue(undefined);
  const b = new Boot(work);
  await b.run();
  expect([b.phase, b.error]).toEqual(['error', 'no list']);
  await b.run();
  expect([b.phase, b.error]).toEqual(['error', 'plain text']);
  await b.run();
  expect([b.phase, b.error]).toEqual(['ready', '']);

  let rejectOld: (e: Error) => void = () => {};
  let resolveNew: () => void = () => {};
  const w2 = vi.fn<() => Promise<void>>()
    .mockImplementationOnce(() => new Promise<void>((_, rej) => { rejectOld = rej; }))
    .mockImplementationOnce(() => new Promise<void>((r) => { resolveNew = r; }));
  const c = new Boot(w2, 10);
  const first = c.run();
  const second = c.run();
  resolveNew();
  await second;
  rejectOld(new Error('late'));
  await first;
  expect([c.phase, c.error]).toEqual(['ready', '']);
});

test('a stale run does not mark a newer ready boot slow or ready', async () => {
  let resolveOld: () => void = () => {};
  const w = vi.fn<() => Promise<void>>()
    .mockImplementationOnce(() => new Promise<void>((r) => { resolveOld = r; }))
    .mockImplementationOnce(() => new Promise<void>(() => {}));
  const b = new Boot(w, 10);
  const first = b.run();
  void b.run();
  resolveOld();
  await first;
  expect(b.phase).toBe('loading');
  await vi.advanceTimersByTimeAsync(20);
  expect(b.phase).toBe('slow');
});
