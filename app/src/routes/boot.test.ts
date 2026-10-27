import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { defaultRegistry } from '@bh-patcher/core';
import { mockEngine, mockPlatform } from '$lib/testing';

const ipc = vi.hoisted(() => ({
  set: vi.fn(async () => {}), mainReady: vi.fn(async () => {}), onRetry: vi.fn(), onState: vi.fn(), get: vi.fn(),
  retry: vi.fn(), quit: vi.fn(), openLog: vi.fn()
}));
const host = vi.hoisted(() => ({ kind: 'web' as string }));
vi.mock('$lib/splash', () => ({ splashIpc: ipc }));
vi.mock('$lib/engine', async (orig) => ({ ...(await orig<object>()), createEngine: () => mockEngine() }));
vi.mock('$lib/platform', () => ({ getPlatform: () => mockPlatform({ kind: host.kind as never }) }));

import Page from './+page.svelte';

beforeEach(() => {
  localStorage.setItem('bhp.consent', '1');
  host.kind = 'web';
  ipc.set.mockClear();
  ipc.mainReady.mockClear().mockResolvedValue(undefined);
  ipc.onRetry.mockReset().mockResolvedValue(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const failList = () => vi.spyOn(defaultRegistry, 'list').mockReturnValue([]);

test('web: shows the card while booting, then the app; the host is not involved', async () => {
  render(Page);
  expect(screen.getByRole('status', { name: 'Blockheads Patcher is starting' })).toBeVisible();
  expect((await screen.findAllByRole('heading')).length).toBeGreaterThan(0);
  expect(screen.queryByRole('status', { name: 'Blockheads Patcher is starting' })).toBeNull();
  expect(ipc.set).not.toHaveBeenCalled();
  expect(ipc.mainReady).not.toHaveBeenCalled();
});

test('web: a failed boot shows the error with details on demand, and Try again recovers', async () => {
  const spy = failList();
  render(Page);
  expect(await screen.findByRole('alert')).toHaveTextContent('couldn’t load its list of fixes');
  expect(screen.queryByRole('button', { name: 'Quit' })).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Open log' }));
  expect(screen.getByText('The list of fixes is empty')).toBeVisible();
  await fireEvent.click(screen.getByRole('button', { name: 'Open log' }));
  expect(screen.queryByText('The list of fixes is empty')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Open log' }));
  spy.mockRestore();
  await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect((await screen.findAllByRole('heading')).length).toBeGreaterThan(0);
});

test('android: the phone layout carries the error and Try again', async () => {
  host.kind = 'tauri-android';
  const spy = failList();
  render(Page);
  expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load the list of fixes.');
  spy.mockRestore();
  await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect((await screen.findAllByRole('heading')).length).toBeGreaterThan(0);
});

test('desktop: pushes the boot state to the splash window and reveals the main window when ready', async () => {
  host.kind = 'tauri-desktop';
  render(Page);
  await waitFor(() => expect(ipc.mainReady).toHaveBeenCalledTimes(1));
  expect(ipc.set).toHaveBeenCalledWith({ boot: 'loading', error: '', version: '0.4.0', lang: 'en' });
  expect((await screen.findAllByRole('heading')).length).toBeGreaterThan(0);
});

test('desktop: an error goes to the splash window, its Try again event reruns the boot', async () => {
  host.kind = 'tauri-desktop';
  let retry: () => void = () => {};
  ipc.onRetry.mockImplementation(async (cb) => { retry = cb; return () => {}; });
  const spy = failList();
  render(Page);
  await waitFor(() => expect(ipc.set).toHaveBeenCalledWith(expect.objectContaining({ boot: 'error', error: 'The list of fixes is empty' })));
  expect(ipc.mainReady).not.toHaveBeenCalled();
  spy.mockRestore();
  retry();
  await waitFor(() => expect(ipc.mainReady).toHaveBeenCalled());
});

test('desktop: IPC failures are ignored and the listener is released, even when unmounted first', async () => {
  host.kind = 'tauri-desktop';
  ipc.set.mockRejectedValue('x');
  ipc.mainReady.mockRejectedValue('x');
  ipc.onRetry.mockRejectedValue('x');
  const a = render(Page);
  await waitFor(() => expect(ipc.mainReady).toHaveBeenCalled());
  a.unmount();
  const off = vi.fn();
  ipc.onRetry.mockResolvedValue(off);
  const b = render(Page);
  await waitFor(() => expect(ipc.onRetry).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  b.unmount();
  expect(off).toHaveBeenCalled();
  const c = render(Page);
  c.unmount();
  await waitFor(() => expect(off).toHaveBeenCalledTimes(2));
});

test('the static start-up card from app.html fades out when the app is ready and goes at once on an error', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const card = () => {
    const el = document.createElement('div');
    el.id = 'boot-splash';
    document.body.append(el);
    return el;
  };
  const a = card();
  render(Page);
  await waitFor(() => expect(a.classList.contains('bs-fade')).toBe(true));
  await vi.advanceTimersByTimeAsync(250);
  expect(a.isConnected).toBe(false);
  cleanup();
  const b = card();
  const spy = failList();
  render(Page);
  await screen.findByRole('alert');
  expect(b.isConnected).toBe(false);
  spy.mockRestore();
  vi.useRealTimers();
});

test('web: a newer deployed version opens the update popup and marks the tab title', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"version":"99.0.0"}')));
  for (const k of ['bhp.upd.checked', 'bhp.upd.seen']) localStorage.removeItem(k);
  try {
    render(Page);
    expect(await screen.findByRole('dialog', { name: 'Patcher 99.0.0 is here' })).toBeInTheDocument();
    expect(document.title).toBe('↑ Blockheads Patcher');
  } finally {
    vi.unstubAllGlobals();
  }
});
