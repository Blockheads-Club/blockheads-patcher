import { afterEach, expect, test, vi } from 'vitest';

vi.mock('./tauri-desktop', () => ({ createTauriDesktopAdapter: () => ({ kind: 'tauri-desktop' }) }));
vi.mock('./tauri-android', () => ({ createTauriAndroidAdapter: () => ({ kind: 'tauri-android' }) }));
import { getPlatform, GAME_PACKAGE } from './index';

afterEach(() => { vi.unstubAllGlobals(); delete (window as never as Record<string, unknown>).__TAURI_INTERNALS__; });

test('selects the adapter for the environment', () => {
  expect(GAME_PACKAGE).toContain('blockheads');
  expect(getPlatform().kind).toBe('web');
  (window as never as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  expect(getPlatform().kind).toBe('tauri-desktop');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla Android 14');
  expect(getPlatform().kind).toBe('tauri-android');
});

test('no window means web', () => {
  vi.stubGlobal('window', undefined);
  expect(getPlatform().kind).toBe('web');
});
