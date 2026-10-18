import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  onState: vi.fn(), get: vi.fn(), retry: vi.fn(async () => {}), quit: vi.fn(async () => {}), openLog: vi.fn(async () => {})
}));
vi.mock('$lib/splash', () => ({ splashIpc: ipc }));

import { setLanguage } from '$lib/i18n';
import type { SplashState } from '$lib/splash';
import Page from './+page.svelte';

const st = (over: Partial<SplashState> = {}): SplashState => ({ boot: 'loading', error: '', version: '1.2.3', lang: 'en', ...over });

beforeEach(() => {
  ipc.onState.mockReset().mockResolvedValue(() => {});
  ipc.get.mockReset().mockResolvedValue(st());
  for (const f of [ipc.retry, ipc.quit, ipc.openLog]) f.mockClear();
});
afterEach(() => { cleanup(); setLanguage('en'); });

test('shows the state the host already holds, with the version', async () => {
  render(Page);
  expect(await screen.findByRole('status', { name: 'Blockheads Patcher is starting' })).toBeVisible();
  expect(screen.getByText('1.2.3')).toBeVisible();
});

test('follows pushed states, switches language, and a pushed state beats the stored one', async () => {
  let push: (s: SplashState) => void = () => {};
  let release: (s: SplashState) => void = () => {};
  ipc.onState.mockImplementation(async (cb) => { push = cb; return () => {}; });
  ipc.get.mockImplementation(() => new Promise((r) => { release = r; }));
  render(Page);
  await waitFor(() => expect(ipc.onState).toHaveBeenCalled());
  push(st({ boot: 'slow', lang: 'tr' }));
  expect(await screen.findByRole('status', { name: 'Blockheads Patcher başlıyor' })).toBeVisible();
  release(st({ boot: 'loading', lang: 'en' }));
  await Promise.resolve();
  expect(screen.getByText(/Hâlâ çalışıyor/)).toBeVisible();
  push(st({ lang: 'xx' }));
  await waitFor(() => expect(screen.getByText(/yükleniyor/)).toBeVisible());
});

test('error buttons call the host', async () => {
  ipc.get.mockResolvedValue(st({ boot: 'error', error: 'denied' }));
  render(Page);
  await fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Open log' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Quit' }));
  expect([ipc.retry, ipc.openLog, ipc.quit].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
});

test('survives IPC errors and releases its listener, even when unmounted first', async () => {
  ipc.onState.mockRejectedValue('x');
  ipc.get.mockRejectedValue('x');
  render(Page);
  await waitFor(() => expect(ipc.get).toHaveBeenCalled());
  cleanup();
  const off = vi.fn();
  ipc.onState.mockResolvedValue(off);
  ipc.get.mockResolvedValue(st());
  const a = render(Page);
  await waitFor(() => expect(ipc.onState).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  a.unmount();
  expect(off).toHaveBeenCalled();
  const b = render(Page);
  b.unmount();
  await waitFor(() => expect(off).toHaveBeenCalledTimes(2));
});

test('uses square corners on macOS', async () => {
  const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla (Macintosh)');
  render(Page);
  expect(await screen.findByRole('status')).toHaveClass('square');
  ua.mockRestore();
});
