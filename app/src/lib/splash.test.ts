import { beforeEach, expect, test, vi } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import { splashIpc } from './splash';

beforeEach(() => { tauri.invoke.mockClear(); tauri.listen.mockReset(); });

test('commands map to the host commands', async () => {
  const state = { boot: 'error' as const, error: 'x', version: '1', lang: 'en' };
  await splashIpc.set(state);
  await splashIpc.get();
  await splashIpc.retry();
  await splashIpc.quit();
  await splashIpc.openLog();
  await splashIpc.mainReady();
  expect(tauri.invoke.mock.calls).toEqual([
    ['splash_set', { state }], ['splash_get'], ['splash_retry'], ['app_quit'], ['open_log'], ['main_ready']
  ]);
});

test('events deliver their payload', async () => {
  const off = () => {};
  tauri.listen.mockImplementation(async (_name: string, cb: (e: { payload: unknown }) => void) => { cb({ payload: 'p' }); return off; });
  const onState = vi.fn();
  const onRetry = vi.fn();
  expect(await splashIpc.onState(onState)).toBe(off);
  await splashIpc.onRetry(onRetry);
  expect(tauri.listen.mock.calls.map((c) => c[0])).toEqual(['splash-state', 'splash-retry']);
  expect(onState).toHaveBeenCalledWith('p');
  expect(onRetry).toHaveBeenCalled();
});
