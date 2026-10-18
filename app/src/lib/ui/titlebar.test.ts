import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { setLanguage } from '$lib/i18n';

const m = vi.hoisted(() => ({
  cur: {
    minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), isMaximized: vi.fn(), isFullscreen: vi.fn(),
    setTitle: vi.fn(), onFocusChanged: vi.fn(), onResized: vi.fn()
  }
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => m.cur }));

import { guessOs, win } from '$lib/winctl';
import TitleBar from './TitleBar.svelte';

let resized: () => void, focused: (e: { payload: boolean }) => void;
const offResize = vi.fn(), offFocus = vi.fn();
beforeEach(() => {
  setLanguage('en');
  vi.clearAllMocks();
  m.cur.isMaximized.mockResolvedValue(false);
  m.cur.onResized.mockImplementation(async (cb: () => void) => { resized = cb; return offResize; });
  m.cur.onFocusChanged.mockImplementation(async (cb: typeof focused) => { focused = cb; return offFocus; });
});

describe('winctl', () => {
  test('guessOs reads the user agent', () => {
    expect(guessOs('Mozilla (Windows NT 10)')).toBe('windows');
    expect(guessOs('Mozilla (Macintosh)')).toBe('macos');
    expect(guessOs('Mozilla (X11; Linux)')).toBe('linux');
    expect(guessOs()).toBe('linux');
  });
  test('win delegates to the current window', async () => {
    m.cur.isFullscreen.mockResolvedValue(true);
    win.minimize(); win.toggleMaximize(); win.close();
    expect(m.cur.minimize).toHaveBeenCalled();
    expect(m.cur.toggleMaximize).toHaveBeenCalled();
    expect(m.cur.close).toHaveBeenCalled();
    await win.isMaximized();
    expect(await win.isFullscreen()).toBe(true);
    const cb = vi.fn();
    await win.onResized(cb);
    await win.onFocus(cb);
    m.cur.onFocusChanged.mock.calls[0]![0]({ payload: true });
    expect(cb).toHaveBeenCalledWith(true);
  });
});

describe('TitleBar', () => {
  test('windows: caption buttons call the window, maximize icon follows state', async () => {
    m.cur.isMaximized.mockResolvedValue(true);
    render(TitleBar, { os: 'windows', ctx: 'Review patches' });
    expect(screen.getByText('· Review patches')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(m.cur.minimize).toHaveBeenCalled();
    expect(m.cur.toggleMaximize).toHaveBeenCalled();
    expect(m.cur.close).toHaveBeenCalled();
    m.cur.isMaximized.mockResolvedValue(false);
    resized();
    await screen.findByRole('button', { name: 'Maximize' });
  });
  test('linux: round buttons, no context when empty, inactive follows focus', async () => {
    const { container, unmount } = render(TitleBar, { os: 'linux' });
    expect(container.querySelector('.ctx')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(m.cur.toggleMaximize).toHaveBeenCalled();
    await waitFor(() => expect(focused).toBeTruthy());
    focused({ payload: false });
    await waitFor(() => expect(container.querySelector('.bar.inactive')).toBeTruthy());
    focused({ payload: true });
    await waitFor(() => expect(container.querySelector('.bar.inactive')).toBeNull());
    unmount();
    await waitFor(() => { expect(offResize).toHaveBeenCalled(); expect(offFocus).toHaveBeenCalled(); });
  });
  test('macos: no custom buttons, room for the native lights; forced maximized look', () => {
    const { container } = render(TitleBar, { os: 'macos', maximized: true });
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('.native')).toBeTruthy();
  });
  test('forced maximized look on windows; window errors are swallowed; late unsubscribe', async () => {
    m.cur.isMaximized.mockRejectedValue(new Error('x'));
    m.cur.onResized.mockRejectedValue(new Error('x'));
    const { unmount } = render(TitleBar, { os: 'windows', maximized: true });
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    unmount();
  });
  test('subscriptions arriving after unmount are released at once', async () => {
    let late!: (u: () => void) => void;
    m.cur.onResized.mockImplementation(() => new Promise((r) => { late = r; }));
    const off = vi.fn();
    const { unmount } = render(TitleBar, { os: 'linux' });
    unmount();
    late(off);
    await waitFor(() => expect(off).toHaveBeenCalled());
  });
});
