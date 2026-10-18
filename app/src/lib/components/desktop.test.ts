import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { setLanguage } from '$lib/i18n';
import { apkFile, mockEngine, mockPlatform } from '$lib/testing';
import { PatcherState } from '$lib/state.svelte';
import { KeysState, MemoryKeyLibrary } from '$lib/keys.svelte';
import { Prefs, giveConsent } from '$lib/prefs.svelte';

const w = vi.hoisted(() => ({
  os: 'linux', max: false, full: false, resize: undefined as undefined | (() => void), fail: false
}));
vi.mock('$lib/winctl', () => ({
  guessOs: () => w.os,
  win: {
    minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(),
    isMaximized: async () => { if (w.fail) throw new Error('x'); return w.max; },
    isFullscreen: async () => w.full,
    onResized: async (cb: () => void) => { w.resize = cb; return () => {}; },
    onFocus: async () => () => {}
  }
}));
import App from './App.svelte';

beforeEach(() => { setLanguage('en'); localStorage.clear(); w.os = 'linux'; w.max = false; w.full = false; w.fail = false; });

function mount(kind = 'tauri-desktop', over = {}) {
  giveConsent();
  const engine = mockEngine(over);
  const state = new PatcherState(mockPlatform({ kind } as never), engine);
  const view = render(App, { state, keys: new KeysState(engine, new MemoryKeyLibrary()), prefs: new Prefs() });
  return { state, ...view };
}

describe('desktop shell', () => {
  test('title bar with per-screen context, rounded frame, fixed-height app', async () => {
    const { container } = mount();
    expect(container.querySelector('.frame.round')).toBeTruthy();
    expect(container.querySelector('.app.desk')).toBeTruthy();
    expect(screen.getByText('· Choose game')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Keys' }));
    expect(screen.getByText('· Signing keys')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText('· Settings')).toBeInTheDocument();
  });
  test('review, patching, done and failed contexts', async () => {
    const { state } = mount();
    await fireEvent.change(screen.getByTestId('apk-input'), { target: { files: [apkFile('g.apk')] } });
    await screen.findByText('· Review patches');
    state.stage = 'patching';
    await screen.findByText('· Patching');
    state.stage = 'done';
    await screen.findByText('· Done');
    state.stage = 'error'; state.runFailed = true;
    await screen.findByText('· Patch failed');
  });
  test('maximized windows are square; resize errors are swallowed', async () => {
    w.max = true;
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.frame.round')).toBeNull());
    w.max = false; w.fail = true;
    w.resize?.();
    await waitFor(() => expect(w.resize).toBeTruthy());
  });
  test('fullscreen windows are square and macOS has native rounding', async () => {
    w.full = true;
    const a = mount();
    await waitFor(() => expect(a.container.querySelector('.frame.round')).toBeNull());
    a.unmount();
    w.full = false; w.os = 'macos';
    const b = mount();
    expect(b.container.querySelector('.frame.round')).toBeNull();
  });
  test('web and android keep the plain layout', () => {
    for (const kind of ['web', 'tauri-android']) {
      const { container, unmount } = mount(kind, {});
      expect(container.querySelector('header[aria-label="Window title bar"]')).toBeNull();
      expect(container.querySelector('.app.desk')).toBeNull();
      unmount();
    }
  });
  test('unmount before the resize subscription resolves', () => {
    const { unmount } = mount();
    unmount();
  });
});
