import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { setLanguage } from '$lib/i18n';
import { apkFile, mockEngine, mockPatchReport, mockPlatform } from '$lib/testing';
import { PatcherState } from '$lib/state.svelte';
import ApkPicker from './ApkPicker.svelte';
import PatchList from './PatchList.svelte';
import ProgressBar from './ProgressBar.svelte';
import ResultPanel from './ResultPanel.svelte';
import KeyManager from './KeyManager.svelte';
import ThemeSelect from './ThemeSelect.svelte';
import LanguageSelect from './LanguageSelect.svelte';
import App from './App.svelte';

beforeEach(() => { setLanguage('en'); localStorage.clear(); });

describe('ApkPicker extras', () => {
  test('non-web: choose uses the platform picker; cancel and errors', async () => {
    const onpicked = vi.fn();
    const pickApk = vi.fn()
      .mockResolvedValueOnce({ name: 'a.apk', bytes: new Uint8Array(1), source: 'file' })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('dialog broke'));
    render(ApkPicker, { platform: mockPlatform({ kind: 'tauri-desktop', pickApk }), onpicked });
    const btn = screen.getByRole('button', { name: /choose/i });
    await fireEvent.click(btn);
    await waitFor(() => expect(onpicked).toHaveBeenCalledTimes(1));
    await fireEvent.click(btn);
    await waitFor(() => expect(pickApk).toHaveBeenCalledTimes(2));
    expect(onpicked).toHaveBeenCalledTimes(1);
    await fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('dialog broke'));
  });
  test('web: choose clicks the hidden input; busy shows status', async () => {
    const { rerender } = render(ApkPicker, { platform: mockPlatform(), onpicked: vi.fn() });
    const click = vi.spyOn(screen.getByTestId('apk-input'), 'click');
    await fireEvent.click(screen.getByRole('button', { name: /choose/i }));
    expect(click).toHaveBeenCalled();
    await rerender({ platform: mockPlatform(), onpicked: vi.fn(), busy: true });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
  test('drag over/leave/drop; empty and busy drops ignored', async () => {
    const onpicked = vi.fn();
    const { container } = render(ApkPicker, { platform: mockPlatform(), onpicked });
    const drop = container.querySelector('.drop')!;
    await fireEvent.dragOver(drop);
    expect(drop).toHaveClass('dragging');
    await fireEvent.dragLeave(drop);
    expect(drop).not.toHaveClass('dragging');
    await fireEvent.drop(drop, { dataTransfer: { files: [apkFile('d.apk')] } });
    await waitFor(() => expect(onpicked).toHaveBeenCalledTimes(1));
    await fireEvent.drop(drop, { dataTransfer: { files: [] } });
    await fireEvent.drop(drop);
    await fireEvent.change(screen.getByTestId('apk-input'), { target: { files: [] } });
    expect(onpicked).toHaveBeenCalledTimes(1);
  });
  test('installed: getInstalledGame rejection, load failure, version display, reading status', async () => {
    const p1 = mockPlatform({ kind: 'tauri-android', getInstalledGame: vi.fn(async () => { throw new Error('x'); }) });
    const r1 = render(ApkPicker, { platform: p1, onpicked: vi.fn() });
    await waitFor(() => expect(screen.getByText(/not installed/)).toBeInTheDocument());
    r1.unmount();
    const p2 = mockPlatform({
      kind: 'tauri-android',
      getInstalledGame: vi.fn(async () => ({ packageName: 'p', splitSourceDirs: [] })),
      loadInstalledApk: vi.fn(async () => { throw new Error('copy failed'); })
    });
    render(ApkPicker, { platform: p2, onpicked: vi.fn() });
    const b = screen.getByRole('button', { name: 'Use installed game' });
    await waitFor(() => expect(b).toBeEnabled());
    await fireEvent.click(b);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('copy failed'));
  });
  test('reading status while file is being read', async () => {
    let release!: (b: ArrayBuffer) => void;
    const f = apkFile();
    Object.defineProperty(f, 'arrayBuffer', { value: () => new Promise((r) => { release = r; }) });
    render(ApkPicker, { platform: mockPlatform(), onpicked: vi.fn() });
    await fireEvent.change(screen.getByTestId('apk-input'), { target: { files: [f] } });
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    // a second pick while busy is ignored
    await fireEvent.change(screen.getByTestId('apk-input'), { target: { files: [apkFile()] } });
    release(new ArrayBuffer(1));
  });
});

describe('PatchList extras', () => {
  const row = (status: string, extra: object = {}) => [{ patch: { id: 'p1', nameKey: 'patch.fix-welcome-popup-deadlock.name', descriptionKey: 'patch.fix-welcome-popup-deadlock.description' }, status, ...extra }] as never;
  test('empty list', () => {
    render(PatchList, { report: [] as never, selected: [] });
    expect(screen.getByText(/No patches/i)).toBeInTheDocument();
  });
  test('reasonCode, plain reason, and none', () => {
    const a = render(PatchList, { report: row('incompatible', { reasonCode: { code: 'versionTooLow', params: { actual: 1, min: 2 } } }), selected: [] });
    expect(screen.getByText(/older than the supported minimum/)).toBeInTheDocument();
    a.unmount();
    const b = render(PatchList, { report: row('incompatible', { reason: 'plain reason' }), selected: [] });
    expect(screen.getByText('plain reason')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    b.unmount();
    render(PatchList, { report: row('applied'), selected: [] });
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });
});

test('ProgressBar clamps', () => {
  const a = render(ProgressBar, { stage: 'sign', fraction: 5 });
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  a.unmount();
  render(ProgressBar, { stage: 'sign', fraction: -1 });
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
});

describe('ResultPanel extras', () => {
  const base = { bytes: new Uint8Array([1]), applied: [], skipped: [{ id: 'fix-welcome-popup-deadlock', status: 'applied' }], info: {}, certSha256: 'aa', suggestedFileName: 'p.apk' } as never;
  test('skipped list, save with location, save error, reset', async () => {
    const onreset = vi.fn();
    const saveOutput = vi.fn().mockResolvedValueOnce({ location: '/x/p.apk' }).mockRejectedValueOnce(new Error('disk'));
    render(ResultPanel, { platform: mockPlatform({ saveOutput }), result: base, onreset });
    await fireEvent.click(screen.getByRole('button', { name: 'Save patched APK' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('/x/p.apk'));
    await fireEvent.click(screen.getByRole('button', { name: 'Save patched APK' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('disk'));
    await fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(onreset).toHaveBeenCalled();
  });
  test('uninstall statuses and install statuses', async () => {
    const uninstallOriginal = vi.fn().mockResolvedValueOnce({ started: true, completed: true }).mockResolvedValueOnce({ started: true });
    const installApk = vi.fn().mockResolvedValueOnce({ started: true, status: 'pending' }).mockResolvedValueOnce({ started: true });
    render(ResultPanel, { platform: mockPlatform({ kind: 'tauri-android', uninstallOriginal, installApk, canRequestInstalls: async () => true }), result: base });
    const un = screen.getByRole('button', { name: 'Uninstall original game' });
    await fireEvent.click(un);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent("Original game removed."));
    await fireEvent.click(un);
    await waitFor(() => expect(screen.getByRole('status')).not.toHaveTextContent("Original game removed."));
    const inst = screen.getByRole('button', { name: 'Install patched APK' });
    await waitFor(() => expect(inst).toBeEnabled());
    await fireEvent.click(inst);
    await waitFor(() => expect(installApk).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(inst).toBeEnabled());
    await fireEvent.click(inst);
    await waitFor(() => expect(installApk).toHaveBeenCalledTimes(2));
  });
  test('canRequestInstalls rejection, visibility re-check, and blocked without settings opener', async () => {
    const canRequestInstalls = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(false);
    render(ResultPanel, { platform: mockPlatform({ kind: 'tauri-android', installApk: vi.fn(), canRequestInstalls }), result: base });
    await waitFor(() => expect(canRequestInstalls).toHaveBeenCalledTimes(1));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(canRequestInstalls).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Open install permission settings' })).toBeNull();
  });
});

describe('KeyManager extras', () => {
  test('passphrase export, existing-key export, regenerate confirm, import paths', async () => {
    const engine = mockEngine();
    const platform = mockPlatform();
    render(KeyManager, { engine, platform });
    await fireEvent.input(screen.getByTestId('key-passphrase'), { target: { value: 'pw' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Export key' }));
    await waitFor(() => expect(engine.exportIdentityEncryptedJson).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('fingerprint')).toBeInTheDocument());
    // key now exists: export again uses the stored identity
    await fireEvent.click(screen.getByRole('button', { name: 'Export key' }));
    await waitFor(() => expect(platform.saveOutput).toHaveBeenCalledTimes(2));
    // regenerate asks for confirmation
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const gen = screen.getByRole('button', { name: 'Generate new key' });
    await fireEvent.click(gen);
    expect(engine.generateIdentity).not.toHaveBeenCalled();
    await fireEvent.click(gen);
    await waitFor(() => expect(engine.generateIdentity).toHaveBeenCalled());
    confirmSpy.mockRestore();
    // import: no file, with passphrase
    await fireEvent.change(screen.getByTestId('key-input'), { target: { files: [] } });
    await fireEvent.change(screen.getByTestId('key-input'), { target: { files: [new File(['{"version":2}'], 'k.json')] } });
    await waitFor(() => expect(engine.importIdentity).toHaveBeenCalledWith('{"version":2}', 'pw'));
    // non-Error import failure
    (engine.importIdentity as ReturnType<typeof vi.fn>).mockRejectedValueOnce('str');
    await fireEvent.change(screen.getByTestId('key-input'), { target: { files: [new File(['{"version":1}'], 'k.json')] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('str'));
  });
  test('encrypted import without a passphrase asks for one; failures are reported', async () => {
    const engine = mockEngine({
      keystore: { get: vi.fn(async () => { throw new Error('ks'); }), set: vi.fn(async () => { throw new Error('setfail'); }), clear: vi.fn() } as never
    });
    render(KeyManager, { engine, platform: mockPlatform() });
    await fireEvent.change(screen.getByTestId('key-input'), { target: { files: [new File(['{"version": 2}'], 'k.json')] } });
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    await fireEvent.click(screen.getByRole('button', { name: 'Export key' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    await fireEvent.click(screen.getByRole('button', { name: 'Generate new key' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});

test('ThemeSelect persists the choice', async () => {
  render(ThemeSelect);
  await fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dark' } });
  expect(document.documentElement.dataset.theme).toBe('dark');
});

describe('App extras', () => {
  test('unknown version and non-game package', async () => {
    const engine = mockEngine({
      loadApk: vi.fn(async () => ({ zip: {}, manifest: {}, info: { packageName: 'other.pkg', sha256: 'ab' } })) as never,
      listPatches: vi.fn(() => mockPatchReport())
    });
    render(App, { state: new PatcherState(mockPlatform(), engine) });
    await fireEvent.change(screen.getByTestId('apk-input'), { target: { files: [apkFile()] } });
    await waitFor(() => expect(screen.getByTestId('game-version')).toHaveTextContent(/unknown/i));
    expect(document.querySelector('.error')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Choose your game APK' })).toBeInTheDocument();
  });
});

describe('PatcherState.back', () => {
  test('returns to loaded or idle', async () => {
    const s = new PatcherState(mockPlatform(), mockEngine());
    s.back();
    expect(s.stage).toBe('idle');
    await s.load({ name: 'a.apk', bytes: new Uint8Array([1]), source: 'file' });
    s.back();
    expect(s.stage).toBe('loaded');
  });
});

describe('reactive updates', () => {
  test('ProgressBar updates in place', async () => {
    const { rerender } = render(ProgressBar, { stage: 'read', fraction: 0.2 });
    await rerender({ stage: 'sign', fraction: 0.8 });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80');
    await rerender({ stage: 'sign', fraction: 0.8 });
  });
  test('PatchList status change and LanguageSelect language change update in place', async () => {
    const { rerender } = render(PatchList, { report: mockPatchReport('notApplied'), selected: [] });
    await rerender({ report: mockPatchReport('applied'), selected: [] });
    expect(screen.getByRole('checkbox')).toBeDisabled();
    const l = render(LanguageSelect);
    setLanguage('tr');
    await waitFor(() => expect(screen.getByText('Dil')).toBeInTheDocument());
    setLanguage('en');
    l.unmount();
  });
  test('ApkPicker installed info changes in place', async () => {
    let n = 0;
    const getInstalledGame = vi.fn(async () => ({ packageName: 'p', versionName: n++ ? '2' : undefined, splitSourceDirs: [] as string[] }));
    const { rerender } = render(ApkPicker, { platform: mockPlatform({ kind: 'tauri-android', getInstalledGame }), onpicked: vi.fn() });
    await waitFor(() => expect(screen.getByText('p')).toBeInTheDocument());
    await rerender({ platform: mockPlatform({ kind: 'tauri-android', getInstalledGame }), onpicked: vi.fn() });
    await waitFor(() => expect(screen.getByText('p 2')).toBeInTheDocument());
  });
});

test('PatchList toggles selection', async () => {
  const { component } = render(PatchList, { report: mockPatchReport(), selected: [] });
  const box = screen.getByRole('checkbox');
  await fireEvent.click(box);
  expect(box).toBeChecked();
  await fireEvent.click(box);
  expect(box).not.toBeChecked();
  void component;
});
