import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { setLanguage } from '$lib/i18n';
import { mockEngine, mockPlatform } from '$lib/testing';
import { PatcherState } from '$lib/state.svelte';
import { KeysState, MemoryKeyLibrary } from '$lib/keys.svelte';
import { Prefs } from '$lib/prefs.svelte';
import ReviewScreen from './ReviewScreen.svelte';
import ProgressScreen from './ProgressScreen.svelte';
import ResultScreen from './ResultScreen.svelte';
import FailureScreen from './FailureScreen.svelte';

beforeEach(() => {
  setLanguage('en'); localStorage.clear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true });
});

const row = (id: string, status: string, extra = {}) => ({
  patch: { id, version: 1, nameKey: `patch.${id}.name`, descriptionKey: `patch.${id}.description`, appliesTo: {}, detect: () => status, apply: () => {} }, status, ...extra
});
const W = 'fix-welcome-popup-deadlock', I = 'fix-iap-store-font-crash';
const picked = () => ({ name: 'game.apk', bytes: new Uint8Array(2), source: 'file' as const });
const keysFor = (engine = mockEngine()) => new KeysState(engine, new MemoryKeyLibrary());

async function loaded(report: unknown[], info: Record<string, unknown> = {}, engineOver = {}) {
  const engine = mockEngine({
    loadApk: vi.fn(async () => ({ info: { packageName: 'com.noodlecake.blockheads', versionName: '1.7.6', versionCode: 5, sha256: 'ab'.repeat(32), ...info } })) as never,
    listPatches: vi.fn(() => report) as never,
    ...engineOver
  });
  const s = new PatcherState(mockPlatform(), engine);
  await s.load(picked());
  return { s, engine };
}

describe('ReviewScreen', () => {
  test('opt-in patches start unselected and show their credit line', async () => {
    const credited = row('raise-target-sdk', 'notApplied');
    Object.assign(credited.patch, { optIn: true, credits: { source: 'JarlPenguin/blockheads-android-patches', url: 'https://example.invalid' } });
    const { s, engine } = await loaded([row(W, 'notApplied'), credited]);
    expect(s.selected).toEqual([W]);
    render(ReviewScreen, { state: s, keys: keysFor(engine), info: s.loaded!.info, file: { name: 'game.apk', size: 1 }, onchangekey: vi.fn() });
    expect(screen.getByText('Off by default')).toBeInTheDocument();
    expect(screen.getByText('Bug list and ideas from JarlPenguin/blockheads-android-patches; implemented independently by Blockheads Club.')).toBeInTheDocument();
  });
  test('lists applicable, applied and incompatible patches; toggling updates the selection', async () => {
    const { s, engine } = await loaded([row(W, 'notApplied'), row(I, 'incompatible', { reasonCode: { code: 'versionTooLow', params: { actual: 1, min: 2 } } })]);
    const keys = keysFor(engine);
    const onchangekey = vi.fn();
    render(ReviewScreen, { state: s, keys, info: s.loaded!.info, file: { name: 'game.apk', size: 61_300_000 }, onchangekey });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Review the fixes');
    expect(screen.getByText('Version 1.7.6 detected')).toBeInTheDocument();
    expect(screen.getByTestId('game-version')).toHaveTextContent('1.7.6 (5)');
    expect(screen.getByText('61.3 MB')).toBeInTheDocument();
    expect(screen.getByText('A new key')).toBeInTheDocument();
    expect(screen.getByText('1 of 1 selected')).toBeInTheDocument();
    expect(screen.getByText('Not for this version')).toBeInTheDocument();
    expect(screen.getByText(/older than the supported minimum/)).toBeInTheDocument();
    const cb = screen.getByRole('checkbox', { name: /Fix freeze/ });
    expect(cb).toBeChecked();
    await fireEvent.click(cb);
    expect(s.selected).toEqual([]);
    await fireEvent.click(cb);
    expect(s.selected).toEqual([W]);
    await fireEvent.click(screen.getByRole('button', { name: 'Change key' }));
    expect(onchangekey).toHaveBeenCalled();
  });
  test('applied patch, plain reason, no reason, unknown version, active key', async () => {
    const { s, engine } = await loaded([row(W, 'applied'), row(I, 'incompatible', { reason: 'because' }), row('x', 'incompatible')], { versionName: undefined, versionCode: undefined });
    await engine.keystore.set({ certificateDer: new Uint8Array([1]) } as never);
    const keys = keysFor(engine);
    await keys.refresh();
    render(ReviewScreen, { state: s, keys, info: s.loaded!.info, file: { name: 'game.apk', size: 5 }, onchangekey: vi.fn() });
    expect(screen.getAllByText('Patches for ?')).toHaveLength(1);
    expect(screen.getByText('Already applied')).toBeInTheDocument();
    expect(screen.getByText('This APK already contains this fix.')).toBeInTheDocument();
    expect(screen.getByText('because')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Already applied/ })).toBeChecked();
    expect(screen.getByText('My key')).toBeInTheDocument();
    expect(screen.getByText('0 of 1 selected')).toBeInTheDocument();
  });
  test('empty list', async () => {
    const { s, engine } = await loaded([]);
    render(ReviewScreen, { state: s, keys: keysFor(engine), info: s.loaded!.info, file: { name: 'g', size: 1 }, onchangekey: vi.fn() });
    expect(screen.getByText('No patches are available for this APK.')).toBeInTheDocument();
  });
});

describe('ProgressScreen', () => {
  test('stages follow the real progress events; log copy; announcements', async () => {
    const { s, engine } = await loaded([row(W, 'notApplied')]);
    const keys = keysFor(engine);
    await engine.keystore.set({ certificateDer: new Uint8Array([1]) } as never);
    await keys.refresh();
    render(ProgressScreen, { state: s, keys, prefs: new Prefs() });
    s.progress = { stage: 'read', fraction: 0 };
    await tick();
    expect(screen.getByText('Reading the game', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText(/step 1 of 4/)).toBeInTheDocument();
    s.progress = { stage: 'write', fraction: 1 };
    await tick();
    expect(screen.getAllByText('Done')).toHaveLength(3);
    expect(screen.getByText(/step 4 of 4/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
    s.progress = { stage: 'done', fraction: 1 };
    await tick();
    expect(screen.getAllByText('Done')).toHaveLength(4);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    await fireEvent.click(screen.getByRole('button', { name: 'Copy log' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('detect'));
    const cancel = vi.spyOn(s, 'cancel');
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalled();
  });
  test('copy failure leaves the label; log hidden by preference; unknown version and new key', async () => {
    const { s, engine } = await loaded([row(W, 'notApplied')], { versionName: undefined });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('no'); }) }, configurable: true });
    const r = render(ProgressScreen, { state: s, keys: keysFor(engine), prefs: new Prefs() });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy log' }));
    await tick();
    expect(screen.getByRole('button', { name: 'Copy log' })).toBeInTheDocument();
    expect(screen.getByText('Created automatically when you patch.')).toBeInTheDocument();
    r.unmount();
    const prefs = new Prefs();
    prefs.setShowLog(false);
    render(ProgressScreen, { state: s, keys: keysFor(engine), prefs });
    expect(screen.queryByRole('log')).toBeNull();
  });
  test('after signing completes and before done, all rows are done', async () => {
    const { s, engine } = await loaded([row(W, 'notApplied')]);
    render(ProgressScreen, { state: s, keys: keysFor(engine), prefs: new Prefs() });
    s.progress = { stage: 'sign', fraction: 1 };
    await tick();
    expect(screen.getAllByText('Done')).toHaveLength(4);
    s.progress = { stage: 'sign', fraction: 0.2 };
    await tick();
    expect(screen.getAllByText('Done')).toHaveLength(3);
  });
});

const result = (over = {}) => ({
  bytes: new Uint8Array(4500), applied: [W], skipped: [], info: { versionName: '1.7.4' }, certSha256: 'ab'.repeat(32), suggestedFileName: 'blockheads-1.7.4-patched.apk', ...over
}) as never;

describe('ResultScreen (web/desktop)', () => {
  test('success: summary, save with and without location, error, skipped patches', async () => {
    const saveOutput = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ location: '/tmp/x.apk' }).mockRejectedValueOnce(new Error('disk full'));
    const platform = mockPlatform({ saveOutput });
    const onreset = vi.fn();
    const r = render(ResultScreen, { platform, result: result({ skipped: [{ id: I, status: 'incompatible' }] }), keys: keysFor(), onreset, onopenkeys: vi.fn() });
    expect(screen.getByText('1 fix applied to The Blockheads 1.7.4 and signed with your key.')).toBeInTheDocument();
    expect(screen.getByText(/Not applied: Fix crash/)).toBeInTheDocument();
    expect(screen.getByTestId('result-file')).toHaveTextContent('blockheads-1.7.4-patched.apk');
    expect(screen.getByTestId('result-cert')).toHaveTextContent('AB:AB:AB');
    expect(screen.getByText(/browser may ask/)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save patched APK' });
    await fireEvent.click(save);
    expect(await screen.findByText('Download started.')).toBeInTheDocument();
    await fireEvent.click(save);
    expect(await screen.findByText('Saved: /tmp/x.apk')).toBeInTheDocument();
    await fireEvent.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
    await fireEvent.click(screen.getByRole('button', { name: 'Patch another game' }));
    expect(onreset).toHaveBeenCalled();
    r.unmount();
  });
  test('desktop hint, plural lead and named key', async () => {
    const keys = keysFor();
    await keys.generate('Work key');
    const fp = keys.keys[0]!.fingerprint;
    render(ResultScreen, { platform: mockPlatform({ kind: 'tauri-desktop' }), result: result({ applied: [W, I], certSha256: fp.replace(/:/g, '') , info: {} }), keys, onreset: vi.fn(), onopenkeys: vi.fn() });
    expect(screen.getByText(/Save dialog/)).toBeInTheDocument();
    expect(screen.getByText(/2 fixes applied/)).toBeInTheDocument();
    expect(screen.getByText(/signed with Work key/)).toBeInTheDocument();
  });
});

describe('ResultScreen (android install flow)', () => {
  const droid = (over = {}) => mockPlatform({
    kind: 'tauri-android', getInstalledGame: vi.fn(async () => ({ packageName: 'p', splitSourceDirs: [] })),
    uninstallOriginal: vi.fn(async () => ({ started: true, completed: true })),
    installApk: vi.fn(async () => ({ started: true, status: 'success' as const })),
    canRequestInstalls: vi.fn(async () => true), openInstallSettings: vi.fn(async () => {}), ...over
  });
  const show = (platform: ReturnType<typeof droid>, extra = {}) => render(ResultScreen, { platform, result: result(), keys: keysFor(), onreset: vi.fn(), onopenkeys: vi.fn(), ...extra });

  test('uninstall is gated by the backup checkbox, then install leads to the done screen', async () => {
    const platform = droid();
    const onopenkeys = vi.fn(), onreset = vi.fn();
    show(platform, { onopenkeys, onreset });
    const un = screen.getByRole('button', { name: 'Uninstall original' });
    expect(un).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Install fixed game' })).toBeDisabled();
    expect(screen.getByText('Available after step 1.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('checkbox'));
    await fireEvent.click(un);
    expect(await screen.findByText('Original uninstalled', { selector: 'p.st' })).toBeInTheDocument();
    expect(screen.getByText('Original game removed.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Install fixed game' }));
    expect(await screen.findByText('All fixed — have fun!')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('link', { name: 'Export it' }));
    expect(onopenkeys).toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Patch another game' }));
    expect(onreset).toHaveBeenCalled();
  });
  test('uninstall cancelled keeps step 1; unknown completion unlocks step 2', async () => {
    const uninstallOriginal = vi.fn().mockResolvedValueOnce({ started: true, completed: false }).mockResolvedValueOnce({ started: true });
    show(droid({ uninstallOriginal }));
    await fireEvent.click(screen.getByRole('checkbox'));
    await fireEvent.click(screen.getByRole('button', { name: 'Uninstall original' }));
    expect(await screen.findByText('Uninstall cancelled; the original game is still installed.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Uninstall original' }));
    expect(await screen.findByText('Android dialog opened.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install fixed game' })).toBeEnabled();
  });
  test('original not installed skips step 1; pending and unknown install statuses; errors', async () => {
    const installApk = vi.fn().mockResolvedValueOnce({ started: true, status: 'pending' }).mockResolvedValueOnce({ started: true }).mockRejectedValueOnce(new Error('install_failed: no'));
    show(droid({ getInstalledGame: vi.fn(async () => null), installApk }));
    expect(await screen.findByText('The original game is not installed on this phone.')).toBeInTheDocument();
    const inst = screen.getByRole('button', { name: 'Install fixed game' });
    await fireEvent.click(inst);
    expect(await screen.findByText(/Installer opened/)).toBeInTheDocument();
    await fireEvent.click(inst);
    expect(await screen.findByText('Android dialog opened.')).toBeInTheDocument();
    await fireEvent.click(inst);
    expect(await screen.findByRole('alert')).toHaveTextContent('Installation failed');
  });
  test('install permission missing: blocked with a settings shortcut; detection failures tolerated', async () => {
    const openInstallSettings = vi.fn(async () => {});
    show(droid({ canRequestInstalls: vi.fn(async () => false), openInstallSettings, getInstalledGame: vi.fn(async () => { throw new Error('x'); }) }));
    expect(await screen.findByText('Allow this app to install packages to continue.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Open install permission settings' }));
    expect(openInstallSettings).toHaveBeenCalled();
    await fireEvent.focus(window);
    window.dispatchEvent(new Event('focus'));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  test('no settings shortcut when the platform lacks it; permission check rejection; save a copy', async () => {
    const saveOutput = vi.fn().mockResolvedValueOnce({ location: '/x' }).mockResolvedValueOnce({});
    const r = show(droid({ canRequestInstalls: vi.fn(async () => false), openInstallSettings: undefined, saveOutput }));
    await screen.findByText('Allow this app to install packages to continue.');
    expect(screen.queryByRole('button', { name: 'Open install permission settings' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Save a copy of the fixed APK' }));
    expect(await screen.findByText('Saved: /x')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Save a copy of the fixed APK' }));
    expect(await screen.findByText('Download started.')).toBeInTheDocument();
    r.unmount();
    show(droid({ canRequestInstalls: vi.fn(async () => { throw new Error('x'); }) }));
    expect(screen.getByRole('button', { name: 'Install fixed game' })).toBeInTheDocument();
  });
  test('platform without optional capabilities', async () => {
    const { installApk, uninstallOriginal } = droid();
    show(mockPlatform({ kind: 'tauri-android', installApk, uninstallOriginal }));
    expect(screen.getByRole('button', { name: 'Uninstall original' })).toBeInTheDocument();
  });
});

describe('FailureScreen', () => {
  test('shows the translated error, retry, keys, copy log, start over', async () => {
    const { s } = await loaded([row(W, 'notApplied')], {}, { patchLoaded: vi.fn(async () => { throw Object.assign(new Error('m'), { name: 'PatchError', code: 'cannotApply', params: { message: 'nope' } }); }) });
    await s.run();
    const onopenkeys = vi.fn();
    render(FailureScreen, { state: s, onopenkeys });
    expect(screen.getByRole('alert')).toHaveTextContent('The patch cannot be applied to this APK (nope).');
    expect(screen.getByRole('log')).toHaveTextContent('error');
    await fireEvent.click(screen.getByRole('button', { name: 'Open Keys' }));
    expect(onopenkeys).toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Copy log' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Report on GitHub' })).toHaveAttribute('href', expect.stringContaining('github.com'));
    const run = vi.spyOn(s, 'run').mockResolvedValue();
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(run).toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(s.stage).toBe('idle');
  });
  test('copy failure keeps the label', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('no'); }) }, configurable: true });
    const { s } = await loaded([row(W, 'notApplied')]);
    s.error = new Error('x');
    render(FailureScreen, { state: s, onopenkeys: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy log' }));
    await tick();
    expect(screen.getByRole('button', { name: 'Copy log' })).toBeInTheDocument();
  });
});
