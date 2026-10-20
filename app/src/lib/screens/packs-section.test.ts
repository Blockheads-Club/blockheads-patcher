import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { setExtraMessages, setLanguage } from '$lib/i18n';
import { PacksState } from '$lib/packs.svelte';
import { memoryPackStore } from '$lib/platform/packs-idb';
import { Prefs } from '$lib/prefs.svelte';
import { mockEngine, mockPatchReport, mockPlatform, packBytes } from '$lib/testing';
import { PatcherState } from '$lib/state.svelte';
import { KeysState, MemoryKeyLibrary } from '$lib/keys.svelte';
import type { PickedFile } from '$lib/platform/types';
import PacksSection from './PacksSection.svelte';
import SettingsScreen from './SettingsScreen.svelte';
import ReviewScreen from './ReviewScreen.svelte';

beforeEach(() => { setLanguage('en'); setExtraMessages({}); localStorage.clear(); });

const fileOf = (bytes: Uint8Array, name: string) => new File([bytes as BlobPart], name);
const packsFor = () => new PacksState(memoryPackStore(), mockEngine());

describe('Imported packs section', () => {
  test('warns, starts empty and imports through the platform picker', async () => {
    const packs = packsFor();
    const pickPack = vi.fn(async (): Promise<PickedFile | null> => ({ name: 'demo.bhpack', bytes: packBytes('demo', 2, { author: 'Ann', description: { en: 'Extra things' } }) }));
    render(PacksSection, { packs, platform: mockPlatform({ kind: 'tauri-android', pickPack }) });
    expect(screen.getByText('Packs come from other people')).toBeInTheDocument();
    expect(screen.getByText('No packs imported.')).toBeInTheDocument();
    expect(screen.getByText('Choose a .bhpack file.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Import pack' }));
    const row = await screen.findByTestId('pack-row');
    expect(within(row).getByText('Pack demo')).toBeInTheDocument();
    expect(row).toHaveTextContent('Version 1.0.0 · by Ann · 2 patches');
    expect(within(row).getByText('Extra things')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('demo.bhpack imported'));
    pickPack.mockResolvedValueOnce(null);
    await fireEvent.click(screen.getByRole('button', { name: 'Import pack' }));
    await fireEvent.click(within(row).getByRole('button', { name: 'Remove Pack demo' }));
    await waitFor(() => expect(screen.queryByTestId('pack-row')).toBeNull());
  });

  test('web: hidden input and drag and drop; refused packs list their problems', async () => {
    const packs = packsFor();
    const { container } = render(PacksSection, { packs, platform: mockPlatform({ kind: 'web' }) });
    expect(screen.getByText('Choose a .bhpack file or drop it here.')).toBeInTheDocument();
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await fireEvent.click(screen.getByRole('button', { name: 'Import pack' }));
    expect(click).toHaveBeenCalled();
    const input = screen.getByTestId('pack-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [fileOf(packBytes('one'), 'one.bhpack')], configurable: true });
    await fireEvent.change(input);
    expect(await screen.findByText('Pack one')).toBeInTheDocument();
    expect(screen.getByText('1 patch', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Version 1.0.0', { exact: false })).toBeInTheDocument();
    Object.defineProperty(input, 'files', { value: null, configurable: true });
    await fireEvent.change(input);

    const section = container.querySelector('section')!;
    await fireEvent.dragOver(section);
    expect(section).toHaveClass('over');
    await fireEvent.dragLeave(section);
    expect(section).not.toHaveClass('over');
    const junk = Array.from({ length: 7 }, (_, i) => ({ op: 'file.add', path: `../x${i}`, from: 'x' }));
    const bad = packBytes('bad', 1, { patches: [{ id: 'p', name: { en: 'P' }, description: { en: 'd' }, ops: junk }] });
    await fireEvent.drop(section, { dataTransfer: { files: [fileOf(bad, 'bad.bhpack')] } });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t import bad.bhpack');
    expect(alert).toHaveTextContent('…and 2 more problems');
    await fireEvent.drop(section, { dataTransfer: { files: [fileOf(packBytes('two'), 'two.bhpack')] } });
    expect(await screen.findByText('Pack two')).toBeInTheDocument();
    expect(screen.getByText('Some imported patches change the same thing')).toBeInTheDocument();
    expect(screen.getByText('“Patch 0” and “Patch 0” both change manifest:application@label. If you tick both, the one listed later wins.')).toBeInTheDocument();
    await fireEvent.drop(section);
  });

  test('desktop: files dropped on the window are imported (only .bhpack/.zip); unsubscribes on unmount', async () => {
    const packs = packsFor();
    let deliver!: (files: PickedFile[]) => void;
    const off = vi.fn();
    const onFileDrop = vi.fn(async (cb: (f: PickedFile[]) => void) => { deliver = cb; return off; });
    const { unmount } = render(PacksSection, { packs, platform: mockPlatform({ kind: 'tauri-desktop', onFileDrop }) });
    await waitFor(() => expect(onFileDrop).toHaveBeenCalled());
    expect(screen.getByText('Choose a .bhpack file or drop it here.')).toBeInTheDocument();
    deliver([{ name: 'a.bhpack', bytes: packBytes('a') }, { name: 'notes.txt', bytes: new Uint8Array([1]) }]);
    expect(await screen.findByText('Pack a')).toBeInTheDocument();
    unmount();
    expect(off).toHaveBeenCalled();
    // unmounted before the subscription resolved: it is undone as soon as it arrives
    let resolve!: (u: () => void) => void;
    const late = vi.fn(() => new Promise<() => void>((r) => { resolve = r; }));
    const second = render(PacksSection, { packs, platform: mockPlatform({ kind: 'tauri-desktop', onFileDrop: late }) });
    second.unmount();
    const off2 = vi.fn();
    resolve(off2);
    await waitFor(() => expect(off2).toHaveBeenCalled());
    const failing = render(PacksSection, { packs, platform: mockPlatform({ kind: 'tauri-desktop', onFileDrop: vi.fn(async () => { throw new Error('no'); }) }) });
    failing.unmount();
  });

  test('stored packs that no longer load can be removed', async () => {
    const store = memoryPackStore();
    await store.put('old', new Uint8Array([1]));
    const packs = new PacksState(store, mockEngine());
    await packs.init();
    render(PacksSection, { packs, platform: mockPlatform() });
    expect(screen.getByText('old.bhpack can’t be loaded any more')).toBeInTheDocument();
    expect(screen.queryByText('No packs imported.')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Remove old.bhpack' }));
    expect(await screen.findByText('No packs imported.')).toBeInTheDocument();
  });

  test('pack names follow the language', async () => {
    setLanguage('tr');
    const packs = packsFor();
    await packs.import('x.bhpack', packBytes('x'));
    await packs.import('y.bhpack', packBytes('y', 1, { name: { en: 'English only' } }));
    render(PacksSection, { packs, platform: mockPlatform() });
    expect(screen.getByText('Paket x')).toBeInTheDocument();
    expect(screen.getByText('English only')).toBeInTheDocument();
    expect(screen.getByText('İçe aktarılan yama paketleri')).toBeInTheDocument();
  });

  test('Settings shows the section when packs are given', () => {
    const packs = packsFor();
    render(SettingsScreen, { prefs: new Prefs(), platformKind: 'web', packs, platform: mockPlatform(), onback: () => {}, onlegal: () => {} });
    expect(screen.getByRole('heading', { name: 'Imported patch packs' })).toBeInTheDocument();
  });
});

describe('pack patches on the Review step', () => {
  test('carry a Pack badge and say where they come from', async () => {
    const packs = packsFor();
    await packs.import('demo.bhpack', packBytes('demo', 2));
    const [p0, p1] = packs.items[0]!.pack.patches;
    const base = (mockPatchReport() as never as { patch: object; status: string }[])[0]!;
    const engine = mockEngine({ listPatches: vi.fn(() => [base, { patch: p0, status: 'notApplied' }, { patch: p1, status: 'applied' }] as never) });
    const s = new PatcherState(mockPlatform(), engine);
    await s.load({ name: 'g.apk', bytes: new Uint8Array([1]), source: 'file' });
    expect(s.selected).toEqual(['fix-welcome-popup-deadlock']); // pack patches are opt-in
    const keys = new KeysState(engine, new MemoryKeyLibrary());
    render(ReviewScreen, { state: s, keys, info: s.loaded!.info, file: { name: 'g.apk', size: 1 }, onchangekey: () => {} });
    expect(screen.getByText('Patch 0')).toBeInTheDocument();
    expect(screen.getAllByText('Pack')).toHaveLength(2);
    expect(screen.getAllByText('Recommended')).toHaveLength(1);
    expect(screen.getByText('From the imported pack “Pack demo” (version 1.0.0). Not part of the Patcher and not checked by its authors.')).toBeInTheDocument();
  });

  test('pack and patch texts follow ru and kk, falling back to English', async () => {
    const packs = packsFor();
    await packs.import('demo.bhpack', packBytes('demo', 1, {
      name: { en: 'Demo', ru: 'Демо-пакет' },
      patches: [{ id: 'p0', name: { en: 'Patch', ru: 'Патч', kk: 'Түзету' }, summary: { en: 'Short', kk: 'Қысқа' }, description: { en: 'Does' }, ops: [{ op: 'manifest.set', target: 'application', attr: 'label', value: 'L' }] }]
    }));
    const [p0] = packs.items[0]!.pack.patches;
    const engine = mockEngine({ listPatches: vi.fn(() => [{ patch: p0, status: 'notApplied' }] as never) });
    const s = new PatcherState(mockPlatform(), engine);
    await s.load({ name: 'g.apk', bytes: new Uint8Array([1]), source: 'file' });
    const keys = new KeysState(engine, new MemoryKeyLibrary());
    const props = { state: s, keys, info: s.loaded!.info, file: { name: 'g.apk', size: 1 }, onchangekey: () => {} };
    setLanguage('ru');
    const r = render(ReviewScreen, props);
    expect(screen.getByText('Патч')).toBeInTheDocument();
    expect(screen.getByText('Short')).toBeInTheDocument();
    expect(screen.getByText(/«Демо-пакет»/)).toBeInTheDocument();
    r.unmount();
    setLanguage('kk');
    const k = render(ReviewScreen, props);
    expect(screen.getByText('Түзету')).toBeInTheDocument();
    expect(screen.getByText('Қысқа')).toBeInTheDocument();
    expect(screen.getByText(/Demo/)).toBeInTheDocument();
    k.unmount();
    setExtraMessages({}); // texts gone: the review falls back to the English pack name the patch carries
    render(ReviewScreen, props);
    expect(screen.getByText(/Demo/)).toBeInTheDocument();
  });
});
