import { beforeEach, describe, expect, test, vi } from 'vitest';

const m = vi.hoisted(() => ({ check: vi.fn(), invoke: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: m.check }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke }));

import { checkInPlaceUpdate, restartApp } from './updater';
import { createTauriDesktopAdapter } from './tauri-desktop';

beforeEach(() => vi.clearAllMocks());

describe('Tauri updater seam', () => {
  test('nothing newer at the endpoint', async () => {
    m.check.mockResolvedValue(null);
    expect(await checkInPlaceUpdate()).toBeNull();
  });
  test('wraps the update: progress from the download events, install, close', async () => {
    const plugin = {
      version: '0.2.0',
      download: vi.fn(async (cb: (e: unknown) => void) => {
        cb({ event: 'Started', data: { contentLength: 100 } });
        cb({ event: 'Progress', data: { chunkLength: 40 } });
        cb({ event: 'Progress', data: { chunkLength: 60 } });
        cb({ event: 'Finished' });
      }),
      install: vi.fn(async () => {}),
      close: vi.fn(async () => {})
    };
    m.check.mockResolvedValue(plugin);
    const u = (await checkInPlaceUpdate())!;
    expect(u.version).toBe('0.2.0');
    const seen: unknown[] = [];
    await u.download((p) => seen.push(p));
    expect(seen).toEqual([{ done: 0, total: 100 }, { done: 40, total: 100 }, { done: 100, total: 100 }, { done: 100, total: 100 }]);
    await u.install();
    await u.close();
    expect([plugin.install.mock.calls.length, plugin.close.mock.calls.length]).toEqual([1, 1]);
    plugin.download.mockImplementation(async (cb: (e: unknown) => void) => { cb({ event: 'Started', data: {} }); });
    seen.length = 0;
    await u.download((p) => seen.push(p));
    expect(seen).toEqual([{ done: 0, total: null }]);
  });
  test('restart asks the shell; the desktop adapter exposes both', async () => {
    await restartApp();
    expect(m.invoke).toHaveBeenCalledWith('app_restart');
    const a = createTauriDesktopAdapter();
    expect([a.checkInPlaceUpdate, a.restart]).toEqual([checkInPlaceUpdate, restartApp]);
  });
});
