import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import { lang, setLanguage } from '$lib/i18n';
import { mockEngine, mockPlatform } from '$lib/testing';
import { KeysState, MemoryKeyLibrary } from '$lib/keys.svelte';
import { Prefs } from '$lib/prefs.svelte';
import KeysScreen from './KeysScreen.svelte';
import SettingsScreen from './SettingsScreen.svelte';
import FirstRunDialog from './FirstRunDialog.svelte';

beforeEach(() => {
  setLanguage('en'); localStorage.clear(); document.documentElement.removeAttribute('data-theme');
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true });
});

function setup() {
  let active: unknown = null;
  let n = 0;
  const engine = mockEngine({
    keystore: { get: vi.fn(async () => active), set: vi.fn(async (v) => { active = v; }), clear: vi.fn(async () => { active = null; }) } as never,
    generateIdentity: vi.fn(async () => ({ certificateDer: new Uint8Array([++n, 9]) })) as never,
    importIdentity: vi.fn(async (j: string) => { if (j.includes('bad')) throw new Error('bad key'); return { certificateDer: new Uint8Array([50, 9]) } as never; })
  });
  const keys = new KeysState(engine, new MemoryKeyLibrary());
  const platform = mockPlatform();
  return { engine, keys, platform };
}
const fileWith = (text: string) => { const f = new File([text], 'k.json'); return f; };
const keyInput = () => screen.getByTestId('key-input');

describe('KeysScreen', () => {
  test('empty state offers generate and import; generate names the first key "My key"', async () => {
    const { keys, platform } = setup();
    const onback = vi.fn();
    render(KeysScreen, { keys, platform, onback });
    expect(await screen.findByText('No signing key yet')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Back to patching' }));
    expect(onback).toHaveBeenCalled();
    const gens = screen.getAllByRole('button', { name: 'Generate new key' });
    await fireEvent.click(gens[1]!);
    expect(await screen.findByText('New key generated.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'My key' })).toBeInTheDocument();
    expect(screen.getByText('In use')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Generate new key' }));
    expect(await screen.findByRole('heading', { name: 'Key 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use this key' })).toBeInTheDocument();
    const nonePanel = screen.queryByText('No signing key yet');
    expect(nonePanel).toBeNull();
  });
  test('generate error is shown; import opens the file chooser', async () => {
    const { keys, platform, engine } = setup();
    engine.generateIdentity = vi.fn(async () => { throw new Error('rng'); }) as never;
    render(KeysScreen, { keys, platform, onback: vi.fn() });
    await screen.findByText('No signing key yet');
    const click = vi.spyOn(keyInput(), 'click');
    await fireEvent.click(screen.getAllByRole('button', { name: 'Import key' })[0]!);
    expect(click).toHaveBeenCalled();
    await fireEvent.click(screen.getAllByRole('button', { name: 'Generate new key' })[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('rng');
    await fireEvent.click(screen.getAllByRole('button', { name: 'Import key' })[1]!);
  });
  test('rename, copy fingerprint, use another key, delete flow', async () => {
    const { keys, platform, engine } = setup();
    await keys.generate('One');
    await keys.generate('Two');
    render(KeysScreen, { keys, platform, onback: vi.fn() });
    await screen.findByRole('heading', { name: 'Two' });
    // rename active
    await fireEvent.click(screen.getByRole('button', { name: 'Rename Two' }));
    const field = screen.getByLabelText('Key name');
    await fireEvent.input(field, { target: { value: 'Main ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { name: 'Main' })).toBeInTheDocument();
    // rename cancel on the other
    await fireEvent.click(screen.getByRole('button', { name: 'Rename One' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Key name')).toBeNull();
    // copy
    await fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(keys.active!.fingerprint);
    // use
    await fireEvent.click(screen.getByRole('button', { name: 'Use this key' }));
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 2 })[0]).toHaveTextContent('One'));
    // delete: cancel then confirm (active key -> keystore cleared)
    await fireEvent.click(screen.getAllByRole('button', { name: 'Delete key' })[0]!);
    expect(screen.getByRole('dialog')).toHaveTextContent('Delete “One”?');
    await fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await fireEvent.click(screen.getAllByRole('button', { name: 'Delete key' })[0]!);
    await fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete key' }));
    await waitFor(() => expect(engine.keystore.clear).toHaveBeenCalled());
    await fireEvent.keyDown(document.body, { key: 'x' });
  });
  test('inactive row: delete dialog closes with Escape; unnamed active key shows the default name', async () => {
    const { keys, platform, engine } = setup();
    await engine.keystore.set({ certificateDer: new Uint8Array([77, 1]) } as never);
    await keys.refresh();
    await keys.generate('Other');
    await engine.keystore.set({ certificateDer: new Uint8Array([77, 1]) } as never);
    render(KeysScreen, { keys, platform, onback: vi.fn() });
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 2 })[0]).toHaveTextContent('My key'));
    await fireEvent.click(screen.getAllByRole('button', { name: 'Delete key' })[1]!);
    expect(screen.getByRole('dialog')).toHaveTextContent('Delete “Other”?');
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await fireEvent.change(keyInput(), { target: { files: [fileWith('{"version":2}')] } });
    await screen.findByRole('dialog');
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  test('rename failure, use failure and delete failure surface an alert; copy failure is silent', async () => {
    const { keys, platform } = setup();
    await keys.generate('One');
    await keys.generate('Two');
    render(KeysScreen, { keys, platform, onback: vi.fn() });
    await screen.findByRole('heading', { name: 'Two' });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('no'); }) }, configurable: true });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await tick();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    vi.spyOn(keys, 'rename').mockRejectedValue(new Error('r-fail'));
    await fireEvent.click(screen.getByRole('button', { name: 'Rename Two' }));
    await fireEvent.submit(screen.getByLabelText('Key name').closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('r-fail');
    vi.spyOn(keys, 'use').mockRejectedValue(new Error('u-fail'));
    await fireEvent.click(screen.getByRole('button', { name: 'Use this key' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('u-fail'));
    vi.spyOn(keys, 'remove').mockRejectedValue(new Error('d-fail'));
    await fireEvent.click(screen.getAllByRole('button', { name: 'Delete key' })[0]!);
    await fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete key' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('d-fail'));
  });
  test('export: password mismatch blocks, empty password exports plain, password encrypts, errors, cancel', async () => {
    const { keys, platform, engine } = setup();
    const saveOutput = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('save-fail')).mockResolvedValue({});
    await keys.generate('One');
    await keys.generate('Two');
    render(KeysScreen, { keys, platform: mockPlatform({ saveOutput }), onback: vi.fn() });
    await screen.findByRole('heading', { name: 'Two' });
    await fireEvent.click(screen.getAllByRole('button', { name: 'Export backup…' })[0]!);
    const pw1 = screen.getByLabelText('Password'), pw2 = screen.getByLabelText('Repeat password');
    await fireEvent.input(pw1, { target: { value: 'abc' } });
    expect(screen.getByText('The passwords don’t match.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save backup' })).toBeDisabled();
    await fireEvent.submit(pw1.closest('form')!); // guarded
    expect(saveOutput).not.toHaveBeenCalled();
    await fireEvent.input(pw2, { target: { value: 'abc' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save backup' }));
    expect(await screen.findByText(/Key exported/)).toBeInTheDocument();
    expect(engine.exportIdentityEncryptedJson).toHaveBeenCalled();
    expect(screen.queryByLabelText('Password')).toBeNull();
    // other key's export button, empty password, failing save
    await fireEvent.click(screen.getAllByRole('button', { name: 'Export backup…' })[1]!);
    await fireEvent.click(screen.getByRole('button', { name: 'Save backup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('save-fail');
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(engine.exportIdentityJson).toHaveBeenCalled();
    await fireEvent.click(screen.getAllByRole('button', { name: 'Export backup…' })[0]!);
  });
  test('inactive key can be exported, renamed and removed from its row', async () => {
    const { keys, platform } = setup();
    await keys.generate('One');
    await keys.generate('Two');
    render(KeysScreen, { keys, platform, onback: vi.fn() });
    await screen.findByRole('heading', { name: 'Two' });
    await fireEvent.click(screen.getAllByRole('button', { name: 'Export backup…' })[1]!);
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });
  test('import: plain file, bad file, unreadable file, encrypted file with password dialog, empty selection', async () => {
    const { keys, platform, engine } = setup();
    render(KeysScreen, { keys, platform, onback: vi.fn() });
    await screen.findByText('No signing key yet');
    await fireEvent.change(keyInput(), { target: { files: [] } });
    await fireEvent.change(keyInput(), { target: { files: [fileWith('{"version":1}')] } });
    expect(await screen.findByText('Key imported.')).toBeInTheDocument();
    await fireEvent.change(keyInput(), { target: { files: [fileWith('bad')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not import key: bad key');
    const unreadable = fileWith('x'); unreadable.text = () => Promise.reject(new Error('eio'));
    await fireEvent.change(keyInput(), { target: { files: [unreadable] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('eio'));
    const unreadable2 = fileWith('x'); unreadable2.text = () => Promise.reject('plain');
    await fireEvent.change(keyInput(), { target: { files: [unreadable2] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('plain'));
    // encrypted: cancel, then submit
    await fireEvent.change(keyInput(), { target: { files: [fileWith('{"version": 2}')] } });
    const dlg = await screen.findByRole('dialog');
    await fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await fireEvent.change(keyInput(), { target: { files: [fileWith('{"version": 2}')] } });
    await fireEvent.input(await screen.findByTestId('import-passphrase'), { target: { value: 'pw' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(engine.importIdentity).toHaveBeenLastCalledWith('{"version": 2}', 'pw'));
    // wrong password path (non-Error rejection)
    engine.importIdentity = vi.fn(async () => { throw 'nope'; }) as never;
    await fireEvent.change(keyInput(), { target: { files: [fileWith('{"version":2}')] } });
    await fireEvent.click(await screen.findByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('nope'));
  });
});

describe('SettingsScreen', () => {
  test('language, theme, log switch, links and legal', async () => {
    const prefs = new Prefs();
    const onback = vi.fn(), onlegal = vi.fn();
    render(SettingsScreen, { prefs, platformKind: 'web', onback, onlegal });
    await fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'tr' } });
    expect(get(lang)).toBe('tr');
    setLanguage('en');
    await tick();
    await fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    await fireEvent.click(screen.getByRole('radio', { name: 'System' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    await fireEvent.click(screen.getByRole('switch'));
    expect(prefs.showLog).toBe(false);
    expect(screen.getByTestId('app-version')).toHaveTextContent(/Version \d+\.\d+\.\d+ · Web app/);
    expect(screen.getByRole('link', { name: 'Open GitHub' })).toHaveAttribute('href', expect.stringContaining('github.com'));
    expect(screen.getByRole('heading', { name: 'Credits' })).toBeInTheDocument();
    expect(screen.getByText(/implemented independently by Blockheads Club/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Read notice' }));
    expect(onlegal).toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Back to patching' }));
    expect(onback).toHaveBeenCalled();
  });
  test('platform names', () => {
    const a = render(SettingsScreen, { prefs: new Prefs(), platformKind: 'tauri-android', onback: vi.fn(), onlegal: vi.fn() });
    expect(screen.getByTestId('app-version')).toHaveTextContent('Android app');
    a.unmount();
    render(SettingsScreen, { prefs: new Prefs(), platformKind: 'tauri-desktop', onback: vi.fn(), onlegal: vi.fn() });
    expect(screen.getByTestId('app-version')).toHaveTextContent('Desktop app');
  });
});

describe('FirstRunDialog', () => {
  test('continue needs the checkbox; quit and hint', async () => {
    const onaccept = vi.fn(), onquit = vi.fn();
    const { rerender } = render(FirstRunDialog, { onaccept, onquit });
    expect(screen.getByRole('dialog', { name: 'Before you start' })).toBeInTheDocument();
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); // consent cannot be dismissed
    const cont = screen.getByRole('button', { name: 'Continue' });
    expect(cont).toBeDisabled();
    expect(screen.getByText('Tick the box to continue.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('checkbox'));
    expect(cont).toBeEnabled();
    expect(screen.queryByText('Tick the box to continue.')).toBeNull();
    await fireEvent.click(cont);
    expect(onaccept).toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Quit' }));
    expect(onquit).toHaveBeenCalled();
    await rerender({ onaccept, onquit, quitHint: true });
    expect(screen.getByText(/close this window/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Read the full legal notice' })).toHaveAttribute('href', expect.stringContaining('/legal'));
  });
  test('review mode is read-only and closes with Esc or Close', async () => {
    const onclose = vi.fn();
    render(FirstRunDialog, { review: true, onclose });
    expect(screen.queryByRole('checkbox')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onclose).toHaveBeenCalledTimes(2);
  });
});
