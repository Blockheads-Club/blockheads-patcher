import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { setLanguage } from '$lib/i18n';
import type { PlatformKind } from '$lib/platform/types';
import { UpdateState, type UpdateInfo } from '$lib/update.svelte';
import UpdateDialog from './UpdateDialog.svelte';
import UpdatesSection from './UpdatesSection.svelte';
import UpdateButton from '$lib/ui/UpdateButton.svelte';
import AppBar from '$lib/ui/AppBar.svelte';

const m = vi.hoisted(() => ({
  cur: { isMaximized: vi.fn(async () => false), onFocusChanged: vi.fn(async () => () => {}), onResized: vi.fn(async () => () => {}) }
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => m.cur }));
import TitleBar from '$lib/ui/TitleBar.svelte';

const NOW = 1_800_000_000_000;
const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  version: '0.2.0', notes: ['Faster patching', 'Fixes'], page: 'https://github.com/rel/v0.2.0',
  download: { name: 'Blockheads.Patcher_0.2.0_x64-setup.exe', url: 'https://github.com/dl/x.exe', size: 5_000_000 }, ...over
});
function mk(kind: PlatformKind = 'tauri-desktop', stage: UpdateState['stage'] = 'available', i: UpdateInfo | null = info()) {
  const u = new UpdateState({ kind, current: '0.1.1', openUrl: vi.fn(async () => {}), now: () => NOW, fetch: vi.fn(async () => new Response('[]')) as never });
  u.stage = stage;
  u.info = stage === 'available' ? i : null;
  u.open = true;
  for (const k of ['check', 'cancel', 'hide', 'show', 'install', 'openPage', 'setAutoCheck', 'setChannel'] as const) vi.spyOn(u, k).mockImplementation((() => undefined) as never);
  return u;
}
const dialog = (u: UpdateState, busy = false) => render(UpdateDialog, { update: u, busy });
const btn = (name: string | RegExp) => screen.getByRole('button', { name });

beforeEach(() => { setLanguage('en'); localStorage.clear(); });

describe('UpdateDialog', () => {
  test('checking: indeterminate progress, Cancel (and Escape) stop the check, no close button', async () => {
    for (const stage of ['checking', 'idle'] as const) {
      const u = mk('tauri-desktop', stage);
      const { unmount } = dialog(u);
      const d = screen.getByRole('dialog', { name: 'Checking for updates…' });
      expect(within(d).getByRole('progressbar', { name: 'Checking for updates' })).toBeInTheDocument();
      expect(screen.getByText('Looking for a new version…')).toHaveAttribute('role', 'status');
      expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
      await fireEvent.click(btn('Cancel'));
      await fireEvent.keyDown(d, { key: 'Escape' });
      expect(u.cancel).toHaveBeenCalledTimes(2);
      unmount();
    }
  });
  test('up to date: names the version, OK and Close hide it', async () => {
    const u = mk('tauri-desktop', 'uptodate');
    dialog(u);
    expect(screen.getByRole('dialog', { name: 'The Patcher is up to date' })).toHaveAccessibleDescription('The Patcher checks again when you open it, at most once a day.');
    expect(screen.getByText('You have the newest version, 0.1.1. Checked just now.')).toBeInTheDocument();
    await fireEvent.click(btn('OK'));
    await fireEvent.click(btn('Close'));
    expect(u.hide).toHaveBeenCalledTimes(2);
  });
  test('offline: alert, website fallback and retry', async () => {
    const u = mk('tauri-desktop', 'error');
    dialog(u);
    expect(screen.getByRole('dialog', { name: 'No connection' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t reach the release page.');
    await fireEvent.click(btn('Download from website'));
    expect(u.openPage).toHaveBeenCalled();
    await fireEvent.click(btn('Try again'));
    expect(u.check).toHaveBeenCalledWith({ popup: true });
  });
  test('desktop: notes, size, kept-data note, Later / Download and install / full notes / Escape', async () => {
    const u = mk();
    dialog(u);
    const d = screen.getByRole('dialog', { name: 'Patcher 0.2.0 is here' });
    expect(d).toHaveAccessibleDescription('You have 0.1.1. Your browser downloads the installer — open it to update.');
    expect(within(screen.getByRole('list', { name: 'What’s new' })).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['Faster patching', 'Fixes']);
    expect(screen.getByText(/Download size 5 MB/)).toBeInTheDocument();
    expect(screen.getByText(/signing keys and settings are kept/)).toBeInTheDocument();
    await fireEvent.click(btn('Full release notes'));
    expect(u.openPage).toHaveBeenCalled();
    await fireEvent.click(btn('Download and install'));
    expect(u.install).toHaveBeenCalled();
    await fireEvent.click(btn('Later'));
    await fireEvent.keyDown(d, { key: 'Escape' });
    expect(u.hide).toHaveBeenCalledTimes(2);
  });
  test('Android and release-page-only variants', () => {
    const a = dialog(mk('tauri-android'));
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('You have 0.1.1. Android asks you to confirm the update.');
    a.unmount();
    dialog(mk('tauri-desktop', 'available', info({ download: undefined, notes: [] })));
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('You have 0.1.1. Pick the package for your system on the release page.');
    expect(screen.getByRole('button', { name: 'Open release page' })).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText(/Download size/)).toBeNull();
  });
  test('web: reload offer, no download; blocked while patching', async () => {
    const u = mk('web', 'available', info({ notes: [], download: undefined }));
    const { unmount } = dialog(u);
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('Reload the page to use it.');
    expect(screen.getByText(/No download needed/)).toBeInTheDocument();
    await fireEvent.click(btn('Reload now'));
    expect(u.install).toHaveBeenCalled();
    unmount();
    dialog(mk('web', 'available', info({ notes: [], download: undefined })), true);
    expect(screen.getByRole('status')).toHaveTextContent('Reloading now would stop it');
    expect(btn('Reload now')).toBeDisabled();
  });
  test('after the hand-off: what to do next, per platform', async () => {
    const cases: [PlatformKind, UpdateInfo, string][] = [
      ['tauri-desktop', info(), 'Your browser is downloading Blockheads.Patcher_0.2.0_x64-setup.exe. When it’s done, close the Patcher and open the file to install 0.2.0.'],
      ['tauri-android', info({ download: { name: 'p.apk', url: 'u', size: 1 } }), 'Your browser is downloading p.apk. Open it when it’s done — Android asks you to confirm the update.'],
      ['tauri-desktop', info({ download: undefined }), 'The release page is open in your browser. Download the package for your system and install it.']
    ];
    for (const [kind, i, text] of cases) {
      const u = mk(kind, 'available', i);
      u.handedOff = true;
      const { unmount } = dialog(u);
      expect(screen.getByRole('dialog', { name: 'Almost done' })).toHaveAccessibleDescription(text);
      await fireEvent.click(btn('Open release page'));
      await fireEvent.click(btn('OK'));
      expect([vi.mocked(u.openPage).mock.calls.length, vi.mocked(u.hide).mock.calls.length]).toEqual([1, 1]);
      unmount();
    }
  });
});

describe('UpdateButton', () => {
  test('states: label, accessible name, dot; a click opens the popup', async () => {
    const u = mk('tauri-desktop', 'idle');
    const { container } = render(UpdateButton, { update: u });
    expect(btn('Check for updates')).not.toHaveAttribute('aria-busy');
    expect(container.querySelector('.pip')).toBeNull();
    await fireEvent.click(btn('Check for updates'));
    expect(u.show).toHaveBeenCalled();
    u.stage = 'checking';
    await vi.waitFor(() => expect(btn('Checking…')).toHaveAttribute('aria-busy', 'true'));
    u.stage = 'available';
    u.info = info();
    await vi.waitFor(() => expect(btn('Update available: 0.2.0')).toHaveTextContent('Update'));
    expect(container.querySelector('.pip')).not.toBeNull();
    u.stage = 'error';
    await vi.waitFor(() => expect(btn('Last update check failed')).toHaveTextContent('Check for updates'));
    u.stage = 'uptodate';
    await vi.waitFor(() => expect(btn('Check for updates')).toBeInTheDocument());
  });
  test('the app bar shows it next to the tabs, also while patching', () => {
    const u = mk('tauri-desktop', 'idle');
    const { unmount } = render(AppBar, { view: 'patch', step: 1, update: u, onnavigate: () => {} });
    expect(btn('Check for updates')).toBeInTheDocument();
    unmount();
    render(AppBar, { view: 'patch', step: 3, locked: true, update: u, onnavigate: () => {} });
    expect(btn('Check for updates')).toBeInTheDocument();
  });
});

describe('Settings → Updates', () => {
  const section = (u: UpdateState) => render(UpdatesSection, { update: u, now: () => NOW });
  test('never checked: Check now runs a check; automatic switch; channel', async () => {
    const u = mk('tauri-desktop', 'idle');
    section(u);
    expect(screen.getByRole('heading', { name: 'Updates' })).toBeInTheDocument();
    expect(screen.getByText('Patcher 0.1.1')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Not checked yet');
    expect(screen.getByText('Last checked: never')).toBeInTheDocument();
    await fireEvent.click(btn('Check now'));
    expect(u.check).toHaveBeenCalledWith();
    const sw = screen.getByRole('switch', { name: 'Check for updates automatically' });
    expect(sw).toBeChecked();
    expect(sw).toHaveAccessibleDescription('When the Patcher opens, at most once a day.');
    await fireEvent.click(sw);
    expect(u.setAutoCheck).toHaveBeenCalledWith(false);
    await fireEvent.click(screen.getByRole('radio', { name: 'Pre-release' }));
    expect(u.setChannel).toHaveBeenCalledWith('beta');
    expect(screen.getByRole('radiogroup', { name: 'Update channel' })).toBeInTheDocument();
  });
  test('checking, up to date (just now / a date), available, failed', async () => {
    const u = mk('tauri-desktop', 'checking');
    section(u);
    expect(btn('Check now')).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Checking…');
    u.stage = 'uptodate';
    u.lastChecked = NOW - 1000;
    await vi.waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Up to date'));
    expect(screen.getByText('Last checked: just now')).toBeInTheDocument();
    u.lastChecked = NOW - 3 * 86_400_000;
    await vi.waitFor(() => expect(screen.getByText(/^Last checked: .*2027/)).toBeInTheDocument());
    u.info = info();
    u.stage = 'available';
    await vi.waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('0.2.0 is available'));
    await fireEvent.click(btn('Show update'));
    expect(u.show).toHaveBeenCalled();
    u.stage = 'error';
    await vi.waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Couldn’t check — you may be offline'));
    expect(screen.getByText('Last successful check: never')).toBeInTheDocument();
    await fireEvent.click(btn('Try again'));
    expect(u.check).toHaveBeenCalled();
  });
  test('web: only the automatic switch, with the reload hint', () => {
    section(mk('web', 'idle'));
    expect(screen.getByRole('switch')).toHaveAccessibleDescription('When the Patcher opens, at most once a day. A new version loads on the next page reload.');
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });
  test('the default clock', () => {
    const u = mk('tauri-desktop', 'uptodate');
    u.lastChecked = Date.now();
    render(UpdatesSection, { update: u });
    expect(screen.getByText('Last checked: just now')).toBeInTheDocument();
  });
});

describe('title-bar chip', () => {
  test('shown while the popup is hidden and there is something to say; opens the popup', async () => {
    const u = mk('tauri-desktop', 'available');
    u.open = false;
    render(TitleBar, { os: 'windows', update: u });
    await fireEvent.click(btn('Update available — open the update window'));
    expect(u.show).toHaveBeenCalled();
    u.stage = 'error';
    await vi.waitFor(() => expect(btn('Update check failed — open the update window')).toBeInTheDocument());
    u.open = true;
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: /update window/ })).toBeNull());
    u.open = false;
    u.stage = 'uptodate';
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: /update window/ })).toBeNull());
  });
  test('no update state, no chip', () => {
    render(TitleBar, { os: 'linux' });
    expect(screen.queryByRole('button', { name: /update window/ })).toBeNull();
  });
});
