import type { PackStore } from './types';

const DB = 'bhp-packs';
const STORE = 'packs';
interface Row { id: string; bytes: Uint8Array; added: number }

/** Web: imported packs in IndexedDB (one record per pack id). */
export class IndexedDbPackStore implements PackStore {
  constructor(private readonly factory: IDBFactory = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
      const r = this.factory.open(DB, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((res, rej) => {
      const tx = db.transaction(STORE, mode);
      let value: T;
      const r = fn(tx.objectStore(STORE));
      r.onsuccess = () => { value = r.result; };
      tx.oncomplete = () => res(value);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    }).finally(() => db.close());
  }
  async list() {
    const rows = (await this.run('readonly', (s) => s.getAll())) as Row[];
    return rows.sort((a, b) => a.added - b.added).map(({ id, bytes }) => ({ id, bytes }));
  }
  async put(id: string, bytes: Uint8Array) {
    const old = (await this.run('readonly', (s) => s.get(id))) as Row | undefined;
    await this.run('readwrite', (s) => s.put({ id, bytes, added: old?.added ?? Date.now() } satisfies Row));
  }
  async remove(id: string) {
    await this.run('readwrite', (s) => s.delete(id));
  }
}

/** Packs kept only for this session (tests, hosts without storage). */
export function memoryPackStore(): PackStore {
  const rows = new Map<string, Uint8Array>();
  return {
    list: async () => [...rows].map(([id, bytes]) => ({ id, bytes })),
    put: async (id, bytes) => { rows.set(id, bytes); },
    remove: async (id) => { rows.delete(id); },
  };
}
