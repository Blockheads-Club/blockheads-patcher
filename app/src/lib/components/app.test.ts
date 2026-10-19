import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { setLanguage } from '$lib/i18n';
import { apkFile, mockEngine, mockPlatform } from '$lib/testing';
import { PatcherState } from '$lib/state.svelte';
import { KeysState, MemoryKeyLibrary } from '$lib/keys.svelte';
import { Prefs, giveConsent, hasConsent } from '$lib/prefs.svelte';
import App from './App.svelte';

beforeEach(() => { setLanguage('en'); localStorage.clear(); document.documentElement.removeAttribute('data-theme'); });

const rows = (status = 'notApplied') => [{
  patch: { id: 'fix-welcome-popup-deadlock', version: 1, nameKey: 'patch.fix-welcome-popup-deadlock.name', descriptionKey: 'patch.fix-welcome-popup-deadlock.description', appliesTo: {}, detect: () => status, apply: () => {} }, status
}] as never;

function mount(over = {}, platformOver = {}, consent = true) {
  if (consent) giveConsent();
  const engine = mockEngine(over);
  const state = new PatcherState(mockPlatform(platformOver), engine);
  const keys = new KeysState(engine, new MemoryKeyLibrary());
  const view = render(App, { state, keys, prefs: new Prefs() });
  return { state, keys, engine, ...view };
}
const choose = async (name = 'g.apk') => {
  await fireEvent.change(screen.getByTestId('apk-input'), { target: { files: [apkFile(name)] } });
  await screen.findByRole('heading', { name: 'Review the fixes' });
};

describe('first run and legal', () => {
  test('consent gate: blocks the app until accepted, remembered afterwards', async () => {
    const { container } = mount({}, {}, false);
    expect(screen.getByRole('dialog', { name: 'Before you start' })).toBeInTheDocument();
    expect((container.querySelector('.under') as HTMLElement & { inert: boolean }).inert).toBe(true);
    await fireEvent.click(screen.getByRole('checkbox'));
    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(hasConsent()).toBe(true);
    expect((container.querySelector('.under') as HTMLElement & { inert: boolean }).inert).toBe(false);
  });
  test('quit tries to close the window and explains how to leave', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    mount({}, {}, false);
    await fireEvent.click(screen.getByRole('button', { name: 'Quit' }));
    expect(close).toHaveBeenCalled();
    expect(screen.getByText(/close this window/)).toBeInTheDocument();
    expect(hasConsent()).toBe(false);
  });
  test('Settings can re-open the notice read-only', async () => {
    mount();
    await fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Read notice' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('navigation', () => {
  test('keys and settings views toggle back; focus lands on the new heading; skip link', async () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Choose your game' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Keys' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Signing keys' })));
    await fireEvent.click(screen.getByRole('button', { name: 'Back to patching' }));
    expect(screen.getByRole('heading', { name: 'Choose your game' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await fireEvent.click(screen.getByRole('button', { name: 'Back to patching' }));
    await fireEvent.click(screen.getByRole('link', { name: 'Skip to content' }));
    expect(document.activeElement).toBe(document.getElementById('main'));
  });
  test('a heading-less screen does not break focus handling', async () => {
    mount();
    document.querySelector('h1')!.remove();
    await fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await tick();
  });
});

describe('patch flow', () => {
  test('choose -> review -> patch -> result -> start over, with step state and key refresh', async () => {
    const m = mount({
      listPatches: vi.fn(() => rows()) as never,
      patchLoaded: vi.fn(async (_a, opts) => {
        opts.onProgress?.('sign', 0.5);
        return { bytes: new Uint8Array(3), applied: ['fix-welcome-popup-deadlock'], skipped: [], info: { versionName: '1.7.4' }, certSha256: 'cc'.repeat(32), suggestedFileName: 'o.apk' };
      }) as never
    });
    await choose();
    expect(screen.getByRole('navigation', { name: 'Patch steps' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Patch game (1 fix)' })).toBeEnabled();
    // untick -> CTA changes and disables
    await fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Patch game' })).toBeDisabled();
    await fireEvent.click(screen.getByRole('checkbox'));
    // back and forth
    await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Choose your game' });
    await choose();
    await fireEvent.click(screen.getByRole('button', { name: 'Patch game (1 fix)' }));
    await screen.findByRole('heading', { name: 'Your game is fixed!' });
    expect(m.state.stage).toBe('done');
    await fireEvent.click(screen.getByRole('button', { name: 'Patch another game' }));
    await screen.findByRole('heading', { name: 'Choose your game' });
  });
  test('many fixes label, key change shortcut from review', async () => {
    const two = [...rows(), { ...rows()[0] as object, patch: { ...(rows()[0] as { patch: object }).patch, id: 'fix-system-font-crash', nameKey: 'patch.fix-system-font-crash.name', descriptionKey: 'patch.fix-system-font-crash.description' } }] as never;
    mount({ listPatches: vi.fn(() => two) as never });
    await choose();
    expect(screen.getByRole('button', { name: 'Patch game (2 fixes)' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Change key' }));
    await screen.findByRole('heading', { name: 'Signing keys' });
  });
  test('while patching the toolbar is locked and cancel returns to review', async () => {
    let started!: () => void;
    const ready = new Promise<void>((r) => { started = r; });
    mount({
      listPatches: vi.fn(() => rows()) as never,
      reload: vi.fn(async (a) => a) as never,
      patchLoaded: vi.fn((_a, opts) => new Promise((_res, rej) => { started(); opts.signal!.addEventListener('abort', () => rej(Object.assign(new Error('c'), { name: 'CancelledError' }))); })) as never
    });
    await choose();
    await fireEvent.click(screen.getByRole('button', { name: 'Patch game (1 fix)' }));
    await ready;
    await screen.findByRole('heading', { name: 'Patching your game…' });
    expect(screen.queryByRole('button', { name: 'Keys' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('heading', { name: 'Review the fixes' });
  });
  test('failure screen replaces review and the stepper marks the step failed; start over', async () => {
    const m = mount({
      listPatches: vi.fn(() => rows()) as never,
      reload: vi.fn(async (a) => a) as never,
      patchLoaded: vi.fn(async () => { throw new Error('boom'); }) as never
    });
    await choose();
    await fireEvent.click(screen.getByRole('button', { name: 'Patch game (1 fix)' }));
    await screen.findByRole('heading', { name: 'Patching didn’t work' });
    expect(document.querySelector('.fail')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Open Keys' }));
    await screen.findByRole('heading', { name: 'Signing keys' });
    await fireEvent.click(screen.getByRole('button', { name: 'Back to patching' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await screen.findByRole('heading', { name: 'Choose your game' });
    expect(m.state.runFailed).toBe(false);
  });
  test('android shell uses the install label and swap flow', async () => {
    mount({ listPatches: vi.fn(() => rows()) as never, patchLoaded: vi.fn(async () => ({ bytes: new Uint8Array(3), applied: ['fix-welcome-popup-deadlock'], skipped: [], info: {}, certSha256: 'cc'.repeat(32), suggestedFileName: 'o.apk' })) as never },
      { kind: 'tauri-android', getInstalledGame: vi.fn(async () => null), loadInstalledApk: vi.fn(), installApk: vi.fn(async () => ({ started: true, status: 'success' })), uninstallOriginal: vi.fn() });
    await screen.findByText('The Blockheads is not installed on this phone.');
    expect(screen.getByText('Install', { selector: '.name' })).toBeInTheDocument();
  });
  test('keys refresh errors are swallowed', async () => {
    const engine = mockEngine({ keystore: { get: vi.fn(async () => { throw new Error('idb'); }), set: vi.fn(), clear: vi.fn() } as never });
    giveConsent();
    render(App, { state: new PatcherState(mockPlatform(), engine), keys: new KeysState(engine, new MemoryKeyLibrary()), prefs: new Prefs() });
    await tick();
    expect(screen.getByRole('heading', { name: 'Choose your game' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Blockheads Patcher' });
    expect(within(nav).getAllByRole('button')).toHaveLength(3);
  });
  test('the Patcher tab leads back from Keys and Settings', async () => {
    const engine = mockEngine({});
    giveConsent();
    render(App, { state: new PatcherState(mockPlatform(), engine), keys: new KeysState(engine, new MemoryKeyLibrary()), prefs: new Prefs() });
    const nav = screen.getByRole('navigation', { name: 'Blockheads Patcher' });
    for (const tab of ['Keys', 'Settings']) {
      await fireEvent.click(within(nav).getByRole('button', { name: tab }));
      expect(screen.queryByRole('heading', { name: 'Choose your game' })).toBeNull();
      await fireEvent.click(within(nav).getByRole('button', { name: 'Patcher' }));
      expect(await screen.findByRole('heading', { name: 'Choose your game' })).toBeInTheDocument();
    }
  });
});
