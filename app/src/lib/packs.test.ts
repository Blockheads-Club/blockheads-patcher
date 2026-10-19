import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { get } from 'svelte/store';
import { defaultRegistry, loadPack, MemoryKeystore } from '@bh-patcher/core';
import { setExtraMessages, setLanguage, t } from './i18n';
import { createInlineEngine } from './engine';
import { PacksState, patchMessages } from './packs.svelte';
import { IndexedDbPackStore, memoryPackStore } from './platform/packs-idb';
import { createWebPlatform, pickFile } from './platform/web';
import { PatcherState } from './state.svelte';
import { mockEngine, mockPatchReport, mockPlatform, packBytes } from './testing';

const loaded = (bytes: Uint8Array) => {
  const r = loadPack(bytes);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return { pack: r.pack, bytes };
};

beforeEach(() => { setLanguage('en'); setExtraMessages({}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('pack stores', () => {
  test('IndexedDB keeps packs by id, oldest first; replacing keeps the position', async () => {
    const s = new IndexedDbPackStore(new IDBFactory());
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(2); await s.put('b', new Uint8Array([2]));
    now.mockReturnValue(1); await s.put('a', new Uint8Array([1]));
    now.mockReturnValue(9); await s.put('b', new Uint8Array([3]));
    expect((await s.list()).map((r) => [r.id, Array.from(r.bytes)])).toEqual([['a', [1]], ['b', [3]]]);
    await s.remove('a');
    expect((await s.list()).map((r) => r.id)).toEqual(['b']);
  });

  test('IndexedDB errors reach the caller', async () => {
    for (const evt of ['onerror', 'onabort'] as const) {
      const tx: Record<string, unknown> = { error: new Error(evt), objectStore: () => ({ getAll: () => ({}) }) };
      const db = { transaction: () => { queueMicrotask(() => (tx[evt] as () => void)()); return tx; }, close: vi.fn() };
      const factory = { open: () => { const r: Record<string, unknown> = { result: db }; queueMicrotask(() => (r.onsuccess as () => void)()); return r; } } as never;
      await expect(new IndexedDbPackStore(factory).list()).rejects.toThrow(evt);
      expect(db.close).toHaveBeenCalled();
    }
    const bad = { open: () => { const r: { onerror?: () => void; error: Error } = { error: new Error('x') }; queueMicrotask(() => r.onerror?.()); return r; } } as never;
    await expect(new IndexedDbPackStore(bad).list()).rejects.toThrow('x');
  });

  test('memory store', async () => {
    const s = memoryPackStore();
    await s.put('a', new Uint8Array([1]));
    expect((await s.list()).map((r) => r.id)).toEqual(['a']);
    await s.remove('a');
    expect(await s.list()).toEqual([]);
  });

  test('the web platform persists in IndexedDB and picks packs with a file input', async () => {
    const p = createWebPlatform();
    expect(p.packStore).toBeInstanceOf(IndexedDbPackStore);
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { value: [new File([new Uint8Array([5])], 'x.bhpack')] });
      this.onchange?.(new Event('change'));
    });
    expect(await p.pickPack!()).toMatchObject({ name: 'x.bhpack', bytes: new Uint8Array([5]) });
    click.mockImplementation(function (this: HTMLInputElement) { this.oncancel?.(new Event('cancel')); });
    expect(await p.pickPack!()).toBeNull();
    click.mockImplementation(function (this: HTMLInputElement) { Object.defineProperty(this, 'files', { value: [] }); this.onchange?.(new Event('change')); });
    expect(await pickFile('.x')).toBeNull();
  });
});

describe('pack texts in i18n', () => {
  test('pack messages are found after the dictionaries, with an English fallback', () => {
    const pack = loaded(packBytes('demo', 1)).pack;
    const m = patchMessages(pack.patches);
    expect(m.en!['patch.pack:demo/p0.name']).toBe('Patch 0');
    expect(m.tr!['patch.pack:demo/p0.summary']).toBe('Does 0');
    expect(patchMessages([{ ...pack.patches[0]!, texts: undefined }])).toEqual({});
    setExtraMessages(m);
    expect(get(t)('patch.pack:demo/p0.name')).toBe('Patch 0');
    setLanguage('tr');
    expect(get(t)('patch.pack:demo/p0.name')).toBe('Yama 0');
    setExtraMessages({ en: { only: 'English only' } });
    expect(get(t)('only')).toBe('English only');
    expect(get(t)('app.title')).toBe('Blockheads Patcher');
    expect(get(t)('missing.key')).toBe('missing.key');
  });
});

describe('PacksState', () => {
  test('init loads stored packs and keeps unreadable ones apart', async () => {
    const store = memoryPackStore();
    await store.put('demo', packBytes('demo', 2));
    await store.put('old', new TextEncoder().encode('junk'));
    const engine = mockEngine();
    const onchange = vi.fn(async () => {});
    const s = new PacksState(store, engine, onchange);
    await s.init();
    expect(s.items.map((x) => x.pack.id)).toEqual(['demo']);
    expect(s.broken).toMatchObject([{ id: 'old', name: 'old.bhpack', issues: [{ code: 'notZip' }] }]);
    expect(engine.setPacks).toHaveBeenCalledWith(s.items);
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(get(t)('patch.pack:demo/p1.name')).toBe('Patch 1');
  });

  test('import validates, stores, replaces by id and reports conflicts; remove forgets', async () => {
    const store = memoryPackStore();
    const s = new PacksState(store, mockEngine());
    expect(await s.import('bad.bhpack', new Uint8Array([1, 2]))).toBe(false);
    expect(s.problem).toMatchObject({ name: 'bad.bhpack', issues: [{ code: 'notZip' }] });
    expect(await s.import('a.bhpack', packBytes('a'))).toBe(true);
    expect(s.problem).toBeNull();
    expect(await s.import('b.bhpack', packBytes('b'))).toBe(true);
    expect(s.conflicts).toEqual([{ a: 'pack:a/p0', b: 'pack:b/p0', on: 'manifest:application@label' }]);
    expect(await s.import('a2.bhpack', packBytes('a', 3))).toBe(true);
    expect(s.items.map((x) => [x.pack.id, x.pack.patches.length])).toEqual([['b', 1], ['a', 3]]);
    expect((await store.list()).map((r) => r.id)).toEqual(['a', 'b']);
    await s.remove('a');
    expect(s.items.map((x) => x.pack.id)).toEqual(['b']);
    expect((await store.list()).map((r) => r.id)).toEqual(['b']);
    expect(s.busy).toBe(false);
  });

  test('a broken stored pack is dropped once replaced or removed', async () => {
    const store = memoryPackStore();
    await store.put('a', new Uint8Array([1]));
    await store.put('b', new Uint8Array([1]));
    const s = new PacksState(store, mockEngine());
    await s.init();
    expect(s.broken.map((b) => b.id)).toEqual(['a', 'b']);
    await s.import('a.bhpack', packBytes('a'));
    expect(s.broken.map((b) => b.id)).toEqual(['b']);
    await s.remove('b');
    expect(s.broken).toEqual([]);
  });

  test('store failures become an import problem', async () => {
    const store = { ...memoryPackStore(), put: vi.fn(async () => { throw new Error('disk full'); }) };
    const s = new PacksState(store, mockEngine());
    expect(await s.import('a.bhpack', packBytes('a'))).toBe(false);
    expect(s.problem!.issues[0]!.message).toBe('disk full');
    store.put.mockImplementationOnce(async () => { throw 'plain'; }); // eslint-disable-line no-throw-literal
    expect(await s.import('a.bhpack', packBytes('a'))).toBe(false);
    expect(s.problem!.issues[0]!.message).toBe('plain');
  });

  test('works without a platform store', async () => {
    const s = new PacksState(undefined, mockEngine());
    await s.import('a.bhpack', packBytes('a'));
    expect((await s.store.list()).map((r) => r.id)).toEqual(['a']);
  });
});

describe('engines with packs', () => {
  test('the inline engine lists and applies pack patches after the built-ins', async () => {
    const e = createInlineEngine(new MemoryKeystore());
    await e.setPacks([loaded(packBytes('demo'))]);
    // another package: every patch is incompatible before any detection runs
    const listed = e.listPatches({ zip: { entries: [] }, manifest: {} as never, info: { packageName: 'x', sha256: '' } });
    expect(listed.every((r) => r.status === 'incompatible')).toBe(true);
    expect(listed.map((r) => r.patch.id)).toEqual([...defaultRegistry.list().map((p) => p.id), 'pack:demo/p0']);
  });
});

describe('PatcherState.refresh', () => {
  test('does nothing without a loaded APK', async () => {
    const engine = mockEngine();
    const s = new PatcherState(mockPlatform(), engine);
    await s.refresh();
    expect(engine.listPatches).not.toHaveBeenCalled();
  });

  test('re-lists through reload (worker) and keeps only still open selections', async () => {
    const row = (mockPatchReport() as never as { patch: object; status: string }[])[0]!;
    const report = (ids: string[]) => ids.map((id) => ({ ...row, patch: { ...row.patch, id } }));
    const listPatches = vi.fn().mockReturnValueOnce(report(['a', 'b'])).mockReturnValue(report(['a', 'pack:x/p']));
    const reload = vi.fn(async (a) => a);
    const engine = mockEngine({ listPatches, reload });
    const s = new PatcherState(mockPlatform(), engine);
    await s.load({ name: 'g.apk', bytes: new Uint8Array([1]), source: 'file' });
    expect(s.selected).toEqual(['a', 'b']);
    await s.refresh();
    expect(reload).toHaveBeenCalled();
    expect(s.report.map((r) => r.patch.id)).toEqual(['a', 'pack:x/p']);
    expect(s.selected).toEqual(['a']);
    // patching passes the selection in list order, not in the order it was ticked
    s.selected = ['pack:x/p', 'a'];
    await s.run();
    expect((engine.patchLoaded as ReturnType<typeof vi.fn>).mock.calls[0]![1].patchIds).toEqual(['a', 'pack:x/p']);
  });

  test('inline engines re-list directly; a load during the reload wins', async () => {
    const engine = mockEngine();
    const s = new PatcherState(mockPlatform(), engine);
    await s.load({ name: 'g.apk', bytes: new Uint8Array([1]), source: 'file' });
    await s.refresh();
    expect(engine.listPatches).toHaveBeenCalledTimes(2);
    let release!: () => void;
    const slow = mockEngine({ reload: vi.fn(() => new Promise((r) => { release = () => r(undefined as never); })) as never });
    const t2 = new PatcherState(mockPlatform(), slow);
    await t2.load({ name: 'g.apk', bytes: new Uint8Array([1]), source: 'file' });
    const pending = t2.refresh();
    t2.reset();
    release();
    await pending;
    expect(slow.listPatches).toHaveBeenCalledTimes(1);
  });
});
