import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { setLanguage } from '$lib/i18n';
import { apkFile, mockEngine, mockPatchReport, mockPlatform } from '$lib/testing';
import { PatcherState } from '$lib/state.svelte';
import LegalNotice from './LegalNotice.svelte';
import LanguageSelect from './LanguageSelect.svelte';
import ApkPicker from './ApkPicker.svelte';
import PatchList from './PatchList.svelte';
import ProgressBar from './ProgressBar.svelte';
import ResultPanel from './ResultPanel.svelte';
import KeyManager from './KeyManager.svelte';
import App from './App.svelte';

beforeEach(() => setLanguage('en'));

test('LegalNotice shows the notice', () => {
  render(LegalNotice);
  expect(screen.getByRole('note')).toHaveTextContent('Not affiliated with Majic Jungle or Noodlecake');
});

test('LanguageSelect switches to Turkish', async () => {
  render(LanguageSelect);
  await fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tr' } });
  expect(localStorage.getItem('bhp.lang')).toBe('tr');
  expect(screen.getByText('Dil')).toBeInTheDocument();
});

describe('ApkPicker', () => {
  test('web: file input yields PickedApk', async () => {
    const onpicked = vi.fn();
    render(ApkPicker, { platform: mockPlatform(), onpicked });
    await fireEvent.change(screen.getByTestId('apk-input'), { target: { files: [apkFile('x.apk')] } });
    await waitFor(() => expect(onpicked).toHaveBeenCalled());
    expect(onpicked.mock.calls[0]![0]).toMatchObject({ name: 'x.apk', source: 'file' });
    expect(onpicked.mock.calls[0]![0].bytes).toBeInstanceOf(Uint8Array);
  });
  test('android: use installed game button', async () => {
    const onpicked = vi.fn();
    const platform = mockPlatform({
      kind: 'tauri-android',
      getInstalledGame: vi.fn(async () => ({ packageName: 'com.noodlecake.blockheads', versionName: '1.7.4', splitSourceDirs: [] })),
      loadInstalledApk: vi.fn(async () => ({ name: 'base.apk', bytes: new Uint8Array(1), source: 'installed' as const }))
    });
    render(ApkPicker, { platform, onpicked });
    const btn = screen.getByRole('button', { name: 'Use installed game' });
    await waitFor(() => expect(btn).toBeEnabled());
    await fireEvent.click(btn);
    await waitFor(() => expect(onpicked).toHaveBeenCalledWith(expect.objectContaining({ source: 'installed' })));
  });
  test('android: split installed game is refused', async () => {
    const platform = mockPlatform({
      kind: 'tauri-android',
      getInstalledGame: vi.fn(async () => ({ packageName: 'com.noodlecake.blockheads', splitSourceDirs: ['/data/app/split_config.arm64.apk'] })),
      loadInstalledApk: vi.fn()
    });
    render(ApkPicker, { platform, onpicked: vi.fn() });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('split into several APK files'));
    expect(screen.getByRole('button', { name: 'Use installed game' })).toBeDisabled();
  });
  test('web: read failure shows a message instead of an unhandled rejection', async () => {
    const onpicked = vi.fn();
    render(ApkPicker, { platform: mockPlatform(), onpicked });
    const bad = apkFile('x.apk');
    Object.defineProperty(bad, 'arrayBuffer', { value: () => Promise.reject(new Error('NotReadableError')) });
    await fireEvent.change(screen.getByTestId('apk-input'), { target: { files: [bad] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('NotReadableError'));
    expect(onpicked).not.toHaveBeenCalled();
  });
  test('android: not installed disables the button', async () => {
    const platform = mockPlatform({ kind: 'tauri-android', getInstalledGame: async () => null });
    render(ApkPicker, { platform, onpicked: vi.fn() });
    await waitFor(() => expect(screen.getByText('The Blockheads is not installed on this device.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Use installed game' })).toBeDisabled();
  });
});

describe('PatchList', () => {
  test('notApplied is selectable, shows description', async () => {
    const { component } = render(PatchList, { report: mockPatchReport(), selected: [] });
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText(/freezes on the "WELCOME TO/)).toBeInTheDocument();
    const cb = screen.getByRole('checkbox');
    expect(cb).toBeEnabled();
    await fireEvent.click(cb);
    expect(cb).toBeChecked();
    void component;
  });
  test.each([['applied', 'Already applied'], ['incompatible', 'Incompatible']] as const)('%s is disabled', (status, label) => {
    render(PatchList, { report: mockPatchReport(status), selected: [] });
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });
});

test('ProgressBar exposes progressbar semantics', () => {
  render(ProgressBar, { stage: 'sign', fraction: 0.42 });
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
  expect(screen.getByText('Signing (42%)')).toBeInTheDocument();
});

describe('ResultPanel', () => {
  const result = { bytes: new Uint8Array([1]), applied: ['fix-welcome-popup-deadlock'], skipped: [], info: {}, certSha256: 'aa', suggestedFileName: 'p.apk' } as never;
  test('web: only save, with signature warning', async () => {
    const platform = mockPlatform();
    render(ResultPanel, { platform, result });
    expect(screen.getByTestId('signature-warning')).toHaveTextContent('Uninstall the original game first');
    expect(screen.queryByRole('button', { name: 'Install patched APK' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Uninstall original game' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Save patched APK' }));
    expect(platform.saveOutput).toHaveBeenCalledWith('p.apk', expect.any(Uint8Array));
  });
  test('install permission is re-checked when the window regains focus', async () => {
    let allowed = false;
    const platform = mockPlatform({
      kind: 'tauri-android',
      installApk: vi.fn(async () => ({ started: true, status: 'success' as const })),
      canRequestInstalls: vi.fn(async () => allowed)
    });
    render(ResultPanel, { platform, result });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install patched APK' })).toBeDisabled());
    allowed = true;
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install patched APK' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Install patched APK' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Installed.'));
  });
  test('uninstall cancel and install conflict are reported', async () => {
    const platform = mockPlatform({
      kind: 'tauri-android',
      uninstallOriginal: vi.fn(async () => ({ started: true, completed: false })),
      installApk: vi.fn(async () => { throw 'install_conflict: INSTALL_FAILED_UPDATE_INCOMPATIBLE'; })
    });
    render(ResultPanel, { platform, result });
    await fireEvent.click(screen.getByRole('button', { name: 'Uninstall original game' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Uninstall cancelled'));
    await fireEvent.click(screen.getByRole('button', { name: 'Install patched APK' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('signature differs'));
  });
  test('android: uninstall + install, blocked when installs disallowed', async () => {
    const platform = mockPlatform({
      kind: 'tauri-android',
      uninstallOriginal: vi.fn(async () => ({ started: true })),
      installApk: vi.fn(async () => ({ started: true })),
      canRequestInstalls: vi.fn(async () => false),
      openInstallSettings: vi.fn(async () => {})
    });
    render(ResultPanel, { platform, result });
    await fireEvent.click(screen.getByRole('button', { name: 'Uninstall original game' }));
    expect(platform.uninstallOriginal).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install patched APK' })).toBeDisabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Open install permission settings' }));
    expect(platform.openInstallSettings).toHaveBeenCalled();
  });
});

describe('KeyManager', () => {
  test('regenerate creates a key and shows fingerprint', async () => {
    const engine = mockEngine();
    render(KeyManager, { engine, platform: mockPlatform() });
    expect(screen.getByText(/No key yet/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Generate new key' }));
    await waitFor(() => expect(screen.getByTestId('fingerprint')).toBeInTheDocument());
  });
  test('export saves JSON; import stores key; bad import shows error', async () => {
    const engine = mockEngine();
    const platform = mockPlatform();
    render(KeyManager, { engine, platform });
    await fireEvent.click(screen.getByRole('button', { name: 'Export key' }));
    await waitFor(() => expect(platform.saveOutput).toHaveBeenCalled());
    const [name, bytes] = (platform.saveOutput as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(name).toBe('blockheads-patcher-key.json');
    expect(new TextDecoder().decode(bytes)).toBe('{"version":1}');
    await fireEvent.change(screen.getByTestId('key-input'), { target: { files: [new File(['{"version":1}'], 'k.json')] } });
    await waitFor(() => expect(screen.getByText('Key imported.')).toBeInTheDocument());
    await fireEvent.change(screen.getByTestId('key-input'), { target: { files: [new File(['nope'], 'k.json')] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not import key: bad key'));
  });
});

describe('App flow', () => {
  test('choose -> review -> patch -> done', async () => {
    const engine = mockEngine();
    const state = new PatcherState(mockPlatform(), engine);
    render(App, { state });
    await fireEvent.change(screen.getByTestId('apk-input'), { target: { files: [apkFile('bh.apk')] } });
    await waitFor(() => expect(screen.getByTestId('game-version')).toHaveTextContent('Version 1.7.4 (code 1548230154)'));
    const patchBtn = screen.getByRole('button', { name: 'Patch and sign' });
    await fireEvent.click(patchBtn);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Patched APK is ready' })).toBeInTheDocument());
    expect(engine.patchLoaded).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ patchIds: ['fix-welcome-popup-deadlock'] }));
    expect(engine.patchApk).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.getByRole('heading', { name: 'Choose your game APK' })).toBeInTheDocument();
  });
  test('load error is shown and flow stays on step 1', async () => {
    const engine = mockEngine({ loadApk: vi.fn(async () => { throw new Error('not an APK'); }) });
    render(App, { state: new PatcherState(mockPlatform(), engine) });
    await fireEvent.change(screen.getByTestId('apk-input'), { target: { files: [apkFile()] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong: not an APK'));
    expect(screen.getByRole('heading', { name: 'Choose your game APK' })).toBeInTheDocument();
  });
  test('patch button disabled when nothing selected', async () => {
    const engine = mockEngine({ listPatches: vi.fn(() => mockPatchReport('applied')) });
    render(App, { state: new PatcherState(mockPlatform(), engine) });
    await fireEvent.change(screen.getByTestId('apk-input'), { target: { files: [apkFile()] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Patch and sign' })).toBeDisabled());
  });
  test('keys tab shows key manager', async () => {
    render(App, { state: new PatcherState(mockPlatform(), mockEngine()) });
    await fireEvent.click(screen.getByRole('button', { name: 'Signing key' }));
    expect(screen.getByRole('heading', { name: 'Signing key' })).toBeInTheDocument();
  });
});
