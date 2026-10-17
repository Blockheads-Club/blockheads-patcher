import { generateIdentity, type SigningIdentity } from './identity';

export interface Keystore {
  get(): Promise<SigningIdentity | null>;
  set(id: SigningIdentity): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryKeystore implements Keystore {
  private id: SigningIdentity | null = null;
  async get() {
    return this.id;
  }
  async set(id: SigningIdentity) {
    this.id = id;
  }
  async clear() {
    this.id = null;
  }
}

const DB_NAME = 'bh-patcher';
const STORE = 'keys';
const RECORD = 'signing-identity';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export class IndexedDbKeystore implements Keystore {
  private factory: IDBFactory;
  constructor(factory?: IDBFactory) {
    this.factory = factory ?? globalThis.indexedDB;
  }
  private open(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
      const r = this.factory.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  private async withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    try {
      const tx = db.transaction(STORE, mode);
      const done = new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      });
      const value = await req(fn(tx.objectStore(STORE)));
      await done;
      return value;
    } finally {
      db.close();
    }
  }
  async get(): Promise<SigningIdentity | null> {
    const v = (await this.withStore('readonly', (s) => s.get(RECORD))) as SigningIdentity | undefined;
    return v ?? null;
  }
  async set(id: SigningIdentity): Promise<void> {
    await this.withStore('readwrite', (s) =>
      s.put({ privateKey: id.privateKey, publicKey: id.publicKey, certificateDer: id.certificateDer }, RECORD),
    );
  }
  async clear(): Promise<void> {
    await this.withStore('readwrite', (s) => s.delete(RECORD));
  }
}

const inflight = new WeakMap<Keystore, Promise<SigningIdentity>>();

/**
 * Returns the persisted identity, creating it on first use. Concurrent callers on the same keystore
 * share one creation so only a single identity is ever generated and persisted.
 */
export function getOrCreateIdentity(ks: Keystore): Promise<SigningIdentity> {
  const pending = inflight.get(ks);
  if (pending) return pending;
  const p = (async () => {
    const existing = await ks.get();
    if (existing) return existing;
    const id = await generateIdentity();
    await ks.set(id);
    return id;
  })().finally(() => inflight.delete(ks));
  inflight.set(ks, p);
  return p;
}
