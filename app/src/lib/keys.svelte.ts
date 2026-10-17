import { certFingerprint, type Engine, type SigningIdentity } from './engine';

/** A named signing key kept in the app's key library (the active key also lives in the engine's keystore). */
export interface KeyEntry { id: string; name: string; addedAt: number; identity: SigningIdentity; }
export interface KeyLibrary {
  list(): Promise<KeyEntry[]>;
  put(entry: KeyEntry): Promise<void>;
  delete(id: string): Promise<void>;
}

export class MemoryKeyLibrary implements KeyLibrary {
  private map = new Map<string, KeyEntry>();
  async list() { return [...this.map.values()].sort((a, b) => a.addedAt - b.addedAt); }
  async put(entry: KeyEntry) { this.map.set(entry.id, entry); }
  async delete(id: string) { this.map.delete(id); }
}

const DB_NAME = 'bh-patcher-library';
const STORE = 'entries';

/** IndexedDB library (CryptoKeys are structured-cloned). Separate database from the core keystore, which stays the single source of the active key. */
export class IndexedDbKeyLibrary implements KeyLibrary {
  constructor(private factory: IDBFactory = globalThis.indexedDB) {}
  private open(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
      const r = this.factory.open(DB_NAME, 1);
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
  async list() { return ((await this.run('readonly', (s) => s.getAll())) as KeyEntry[]).sort((a, b) => a.addedAt - b.addedAt); }
  async put(entry: KeyEntry) { await this.run('readwrite', (s) => s.put(entry)); }
  async delete(id: string) { await this.run('readwrite', (s) => s.delete(id)); }
}

export interface KeyView { id: string; name: string; addedAt: number; fingerprint: string; pairs: string[]; active: boolean; }

/** Fingerprint of a certificate as "AB:CD:…" (uppercase). */
export async function fingerprintOf(id: SigningIdentity): Promise<string> {
  return (await certFingerprint(id.certificateDer)).toUpperCase();
}

/**
 * Key list shared by the Keys screen, the Review step and the status bar.
 * The engine keystore holds the active key (what the pipeline signs with); the library remembers every key by name.
 */
export class KeysState {
  keys = $state.raw<KeyView[]>([]);
  ready = $state(false);
  active = $derived(this.keys.find((k) => k.active) ?? null);

  private entries = new Map<string, KeyEntry>();

  constructor(private engine: Engine, private library: KeyLibrary) {}

  async refresh(): Promise<void> {
    const active = await this.engine.keystore.get();
    const activeId = active ? await fingerprintOf(active) : null;
    let list = await this.library.list();
    if (active && activeId && !list.some((e) => e.id === activeId)) {
      // A key created by an earlier version or by the first patch: remember it in the library.
      const entry: KeyEntry = { id: activeId, name: '', addedAt: Date.now(), identity: active };
      await this.library.put(entry);
      list = [...list, entry];
    }
    this.entries = new Map(list.map((e) => [e.id, e]));
    this.keys = list.map((e) => ({ id: e.id, name: e.name, addedAt: e.addedAt, fingerprint: e.id, pairs: e.id.split(':'), active: e.id === activeId }));
    this.ready = true;
  }

  private async add(identity: SigningIdentity, name: string): Promise<void> {
    const id = await fingerprintOf(identity);
    const existing = this.entries.get(id);
    await this.library.put(existing ?? { id, name, addedAt: Date.now(), identity });
    await this.engine.keystore.set(identity);
    await this.refresh();
  }

  async generate(name: string): Promise<void> { await this.add(await this.engine.generateIdentity(), name); }

  async import(text: string, passphrase: string | undefined, name: string): Promise<void> {
    await this.add(await this.engine.importIdentity(text, passphrase || undefined), name);
  }

  async use(id: string): Promise<void> {
    await this.engine.keystore.set(this.entries.get(id)!.identity);
    await this.refresh();
  }

  async rename(id: string, name: string): Promise<void> {
    await this.library.put({ ...this.entries.get(id)!, name });
    await this.refresh();
  }

  async remove(id: string): Promise<void> {
    const isActive = this.keys.find((k) => k.id === id)?.active;
    await this.library.delete(id);
    if (isActive) await this.engine.keystore.clear();
    await this.refresh();
  }

  async exportJson(id: string, passphrase: string): Promise<string> {
    const identity = this.entries.get(id)!.identity;
    return passphrase ? this.engine.exportIdentityEncryptedJson(identity, passphrase) : this.engine.exportIdentityJson(identity);
  }
}
