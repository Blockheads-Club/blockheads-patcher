import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { IndexedDbKeyLibrary, KeysState, MemoryKeyLibrary, fingerprintOf, type KeyEntry } from './keys.svelte';
import { mockEngine } from './testing';

const ident = (n: number) => ({ certificateDer: new Uint8Array([n, n + 1]) }) as never;

function setup(lib = new MemoryKeyLibrary()) {
  let active: unknown = null;
  let counter = 100;
  const engine = mockEngine({
    keystore: { get: vi.fn(async () => active), set: vi.fn(async (v) => { active = v; }), clear: vi.fn(async () => { active = null; }) } as never,
    generateIdentity: vi.fn(async () => ident(counter++)) as never,
    importIdentity: vi.fn(async (_j: string, _p?: string) => ident(7)) as never
  });
  return { engine, lib, keys: new KeysState(engine, lib), setActive: (v: unknown) => { active = v; } };
}

describe('KeysState', () => {
  test('empty, then an auto-created active key is remembered', async () => {
    const { keys, setActive, lib } = setup();
    await keys.refresh();
    expect(keys.ready).toBe(true);
    expect(keys.keys).toEqual([]);
    expect(keys.active).toBeNull();
    setActive(ident(1));
    await keys.refresh();
    expect(keys.keys).toHaveLength(1);
    expect(keys.active?.pairs.length).toBe(keys.active?.fingerprint.split(':').length);
    expect((await lib.list())).toHaveLength(1);
  });
  test('generate, use, rename, export, remove', async () => {
    const { keys, engine } = setup();
    await keys.generate('A');
    await keys.generate('B');
    expect(keys.keys.map((k) => k.name)).toEqual(['A', 'B']);
    expect(keys.active?.name).toBe('B');
    await keys.use(keys.keys[0]!.id);
    expect(keys.active?.name).toBe('A');
    await keys.rename(keys.keys[0]!.id, 'Renamed');
    expect(keys.keys[0]!.name).toBe('Renamed');
    expect(await keys.exportJson(keys.keys[0]!.id, '')).toBe('{"version":1}');
    expect(await keys.exportJson(keys.keys[0]!.id, 'pw')).toBe('{"version":2}');
    await keys.remove(keys.keys[1]!.id); // not active
    expect(engine.keystore.clear).not.toHaveBeenCalled();
    await keys.remove(keys.keys[0]!.id); // active
    expect(engine.keystore.clear).toHaveBeenCalled();
    expect(keys.keys).toEqual([]);
  });
  test('import adds once and keeps the existing name for a known key', async () => {
    const { keys, engine } = setup();
    await keys.import('{"version":1}', '', 'First');
    await keys.import('{"version":1}', 'pw', 'Second');
    expect(keys.keys).toHaveLength(1);
    expect(keys.keys[0]!.name).toBe('First');
    expect(engine.importIdentity).toHaveBeenLastCalledWith('{"version":1}', 'pw');
    expect(await fingerprintOf(ident(7))).toBe(keys.keys[0]!.id);
  });
});

describe('IndexedDbKeyLibrary', () => {
  let lib: IndexedDbKeyLibrary;
  beforeEach(() => { lib = new IndexedDbKeyLibrary(new IDBFactory()); });
  test('put, list ordered by date, delete', async () => {
    const e = (id: string, addedAt: number): KeyEntry => ({ id, name: id, addedAt, identity: { certificateDer: new Uint8Array([1]) } as never });
    await lib.put(e('b', 2));
    await lib.put(e('a', 1));
    expect((await lib.list()).map((x) => x.id)).toEqual(['a', 'b']);
    await lib.delete('a');
    expect((await lib.list()).map((x) => x.id)).toEqual(['b']);
  });
  test('default factory is the global indexedDB', async () => {
    expect(await new IndexedDbKeyLibrary().list()).toEqual([]);
  });
  test('transaction errors and aborts reject', async () => {
    for (const evt of ['onerror', 'onabort'] as const) {
      const tx: Record<string, unknown> = { error: new Error(evt), objectStore: () => ({ getAll: () => ({}) }) };
      const db = { transaction: () => { queueMicrotask(() => (tx[evt] as () => void)()); return tx; }, close: vi.fn() };
      const factory = { open: () => { const r: Record<string, unknown> = { result: db }; queueMicrotask(() => (r.onsuccess as () => void)()); return r; } } as never;
      await expect(new IndexedDbKeyLibrary(factory).list()).rejects.toThrow(evt);
      expect(db.close).toHaveBeenCalled();
    }
  });
  test('open errors reject', async () => {
    const bad = { open: () => { const r: { onerror?: () => void; error: Error } = { error: new Error('x') }; queueMicrotask(() => r.onerror?.()); return r; } } as never;
    await expect(new IndexedDbKeyLibrary(bad).list()).rejects.toThrow('x');
  });
});
