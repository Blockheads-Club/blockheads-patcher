import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { setLanguage } from '$lib/i18n';
import { apkFile, mockEngine, mockPlatform } from '$lib/testing';
import { PatcherState } from '$lib/state.svelte';
import ChooseScreen from './ChooseScreen.svelte';

beforeEach(() => { setLanguage('en'); localStorage.clear(); });
const picked = (name = 'a.apk') => ({ name, bytes: new Uint8Array([1, 2]), source: 'file' as const });
const mk = (platform = mockPlatform(), engine = mockEngine()) => new PatcherState(platform, engine);
const input = () => screen.getByTestId('apk-input') as HTMLInputElement;

describe('web', () => {
  test('browse opens the input; choosing a file loads it', async () => {
    const s = mk();
    const load = vi.spyOn(s, 'load');
    render(ChooseScreen, { state: s });
    const click = vi.spyOn(input(), 'click');
    await fireEvent.click(screen.getByRole('button', { name: 'Browse files' }));
    expect(click).toHaveBeenCalled();
    await fireEvent.change(input(), { target: { files: [apkFile('x.apk')] } });
    await waitFor(() => expect(load).toHaveBeenCalled());
    await fireEvent.change(input(), { target: { files: [] } });
    expect(load).toHaveBeenCalledTimes(1);
  });
  test('reading state from a slow file read, cancel drops the result', async () => {
    const s = mk();
    const load = vi.spyOn(s, 'load');
    render(ChooseScreen, { state: s });
    let release!: (b: ArrayBuffer) => void;
    const f = new File([new Uint8Array(3)], 'slow.apk');
    f.arrayBuffer = () => new Promise((r) => { release = r; });
    await fireEvent.change(input(), { target: { files: [f] } });
    expect(await screen.findByText('slow.apk')).toBeInTheDocument();
    // a second file while reading is ignored
    await fireEvent.drop(document.querySelector('.drop')!, { dataTransfer: { files: [apkFile('other.apk')] } });
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel reading' }));
    release(new ArrayBuffer(3));
    await new Promise((r) => setTimeout(r, 5));
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Browse files' })).toBeInTheDocument();
  });
  test('read failure shows an error naming the file; a stale failure is ignored', async () => {
    const s = mk();
    render(ChooseScreen, { state: s });
    const f = new File([new Uint8Array(3)], 'broken.apk');
    f.arrayBuffer = () => Promise.reject(new Error('disk gone'));
    await fireEvent.change(input(), { target: { files: [f] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/broken\.apk/);
    expect(screen.getByRole('alert')).toHaveTextContent('disk gone');
    // cancelled read that later fails
    let fail!: (e: unknown) => void;
    const g = new File([new Uint8Array(3)], 'g.apk');
    g.arrayBuffer = () => new Promise((_r, rej) => { fail = rej; });
    await fireEvent.change(input(), { target: { files: [g] } });
    await fireEvent.click(await screen.findByRole('button', { name: 'Cancel reading' }));
    fail(new Error('late'));
    await new Promise((r) => setTimeout(r, 5));
    expect(screen.queryByText(/late/)).toBeNull();
  });
  test('engine load error shows translated message with the file name', async () => {
    const s = mk(mockPlatform(), mockEngine({ loadApk: vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'PatchError', code: 'notApk', params: { message: 'zip' } }); }) as never }));
    render(ChooseScreen, { state: s });
    await s.load(picked('photo.zip'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/photo\.zip.*not a valid APK/s);
  });
  test('loading shows the pending file', async () => {
    let resolve!: (v: unknown) => void;
    const engine = mockEngine({ loadApk: vi.fn(() => new Promise((r) => { resolve = r; })) as never });
    const s = mk(mockPlatform(), engine);
    render(ChooseScreen, { state: s });
    const p = s.load(picked('big.apk'));
    expect(await screen.findByText('big.apk')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel reading' }));
    expect(s.loading).toBe(false);
    await waitFor(() => expect(engine.loadApk).toHaveBeenCalled());
    resolve({ info: { packageName: 'p' } });
    await p;
  });
  test('unsupported version and wrong package messages', async () => {
    const s = mk();
    render(ChooseScreen, { state: s });
    s.unsupported = { name: 'v.apk', packageName: 'com.noodlecake.blockheads', versionName: '1.7.3', wrongPackage: false, reason: { code: 'versionTooLow', params: { actual: 1, min: 2 } } };
    expect(await screen.findByText('Version 1.7.3 isn’t supported')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Which versions are supported?' })).toBeInTheDocument();
    s.unsupported = { name: 'v.apk', packageName: 'com.noodlecake.blockheads', wrongPackage: false };
    expect(await screen.findByText('Version ? isn’t supported')).toBeInTheDocument();
    s.unsupported = { name: 'photo.zip', packageName: 'org.other', wrongPackage: true };
    expect(await screen.findByText('This file isn’t The Blockheads')).toBeInTheDocument();
    s.unsupported = null;
    s.error = new Error('boom');
    s.lastName = null;
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/boom/));
  });
});

describe('native platforms', () => {
  test('desktop picker: success, cancel, error', async () => {
    const pickApk = vi.fn().mockResolvedValueOnce(picked()).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('dialog broke'));
    const s = mk(mockPlatform({ kind: 'tauri-desktop', pickApk }));
    const load = vi.spyOn(s, 'load').mockResolvedValue();
    render(ChooseScreen, { state: s });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Choose the game APK');
    const b = () => screen.getByRole('button', { name: 'Browse files' });
    await fireEvent.click(b());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await fireEvent.click(b());
    await waitFor(() => expect(pickApk).toHaveBeenCalledTimes(2));
    expect(load).toHaveBeenCalledTimes(1);
    await fireEvent.click(b());
    expect(await screen.findByRole('alert')).toHaveTextContent('dialog broke');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('We couldn’t open the file');
  });
});

describe('android', () => {
  const installed = { packageName: 'com.noodlecake.blockheads', versionName: '1.7.6', versionCode: 9, splitSourceDirs: [] as string[] };
  const droid = (over = {}) => mockPlatform({ kind: 'tauri-android', getInstalledGame: vi.fn(async () => installed), loadInstalledApk: vi.fn(async () => picked('base.apk')), ...over });

  test('installed game found: use it', async () => {
    const s = mk(droid());
    const load = vi.spyOn(s, 'load').mockResolvedValue();
    render(ChooseScreen, { state: s });
    expect(await screen.findByText('Found on this phone')).toBeInTheDocument();
    expect(screen.getByText('1.7.6')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Use installed game' }));
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Pick an APK file' })).toBeInTheDocument();
  });
  test('installed without version name; pick another file', async () => {
    const pickApk = vi.fn(async () => null);
    render(ChooseScreen, { state: mk(droid({ pickApk, getInstalledGame: vi.fn(async () => ({ ...installed, versionName: undefined })) })) });
    await screen.findByText('Found on this phone');
    await fireEvent.click(screen.getByRole('button', { name: 'Pick an APK file' }));
    expect(pickApk).toHaveBeenCalled();
  });
  test('not installed, or detection failing', async () => {
    const r = render(ChooseScreen, { state: mk(droid({ getInstalledGame: vi.fn(async () => null) })) });
    expect(await screen.findByText('The Blockheads is not installed on this phone.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use installed game' })).toBeNull();
    r.unmount();
    render(ChooseScreen, { state: mk(droid({ getInstalledGame: vi.fn(async () => { throw new Error('x'); }) })) });
    expect(await screen.findByText('The Blockheads is not installed on this phone.')).toBeInTheDocument();
  });
  test('split APKs disable using the installed game', async () => {
    render(ChooseScreen, { state: mk(droid({ getInstalledGame: vi.fn(async () => ({ ...installed, splitSourceDirs: ['a'] })) })) });
    expect(await screen.findByRole('alert')).toHaveTextContent(/split/);
    expect(screen.getByRole('button', { name: 'Use installed game' })).toBeDisabled();
  });
  test('loading the installed game fails: error panel, installed card stays reachable', async () => {
    const loadInstalledApk = vi.fn(async () => { throw new Error('unsupported: split'); });
    render(ChooseScreen, { state: mk(droid({ loadInstalledApk })) });
    await fireEvent.click(await screen.findByRole('button', { name: 'Use installed game' }));
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Use installed game' })).toBeInTheDocument();
  });
  test('while reading the installed card is hidden', async () => {
    let resolve!: (v: unknown) => void;
    const engine = mockEngine({ loadApk: vi.fn(() => new Promise((r) => { resolve = r; })) as never });
    const s = mk(droid(), engine);
    render(ChooseScreen, { state: s });
    await screen.findByText('Found on this phone');
    const p = s.load(picked('i.apk'));
    expect(await screen.findByText('i.apk')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use installed game' })).toBeDisabled();
    await waitFor(() => expect(engine.loadApk).toHaveBeenCalled());
    resolve({ info: { packageName: 'p' } });
    await p;
  });
});
