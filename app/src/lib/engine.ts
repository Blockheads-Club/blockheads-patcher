// Single seam between the UI and @bh-patcher/core, so components and state can be tested with a mock engine.
import {
  loadApk, listPatches, patchApk, patchLoadedApk, IndexedDbKeystore, generateIdentity, exportIdentityJson,
  exportIdentityEncryptedJson, importIdentity, getOrCreateIdentity, defaultRegistry, registryWithPacks, parseModLoaderZip, setModLoaderArtifact,
  type LoadedApk, type ApplicableReport, type PatchApkOptions, type PatchApkResult, type Keystore, type SigningIdentity,
  type Pack, type PatchRegistry
} from '@bh-patcher/core';
import { createWorkerEngine } from './worker/client';
import { spawnApkWorker } from './worker/spawn';

export type { LoadedApk, ApplicableReport, PatchApkResult, Keystore, SigningIdentity };
/** An imported pack: the validated Pack plus the .bhpack bytes it came from (the worker validates them again). */
export interface LoadedPack { pack: Pack; bytes: Uint8Array }

export interface Engine {
  keystore: Keystore;
  loadApk(bytes: Uint8Array): Promise<LoadedApk>;
  listPatches(apk: LoadedApk): ApplicableReport;
  patchApk(input: Uint8Array, opts: Omit<PatchApkOptions, 'keystore' | 'registry'>): Promise<PatchApkResult>;
  /** Patches an already loaded APK (no second read). Mutates `apk`. */
  patchLoaded(apk: LoadedApk, opts: Omit<PatchApkOptions, 'keystore' | 'registry'>): Promise<PatchApkResult>;
  /** The mod loader build (the pinned zip, checked again) that the mod-loader patch installs. */
  setModLoader(zip: Uint8Array): Promise<void>;
  /** Built-in patches followed by the patches of these packs, for every later list and patch call. */
  setPacks(packs: LoadedPack[]): Promise<void>;
  /** Worker engines only: restores `apk` to its freshly parsed state after a failed or cancelled patch. */
  reload?(apk: LoadedApk): Promise<LoadedApk>;
  /** Worker engines only: frees the archive held by the worker. */
  release?(apk: LoadedApk): void;
  /** Persisted identity, created once even under concurrent calls. */
  getOrCreateIdentity(): Promise<SigningIdentity>;
  generateIdentity(): Promise<SigningIdentity>;
  exportIdentityJson(id: SigningIdentity): Promise<string>;
  exportIdentityEncryptedJson(id: SigningIdentity, passphrase: string): Promise<string>;
  importIdentity(json: string, passphrase?: string): Promise<SigningIdentity>;
}

/** Runs everything on the calling thread (tests, environments without Web Workers). */
export function createInlineEngine(keystore: Keystore = new IndexedDbKeystore()): Engine {
  let registry: PatchRegistry = defaultRegistry;
  return {
    keystore,
    loadApk,
    listPatches: (apk) => listPatches(apk, registry),
    patchApk: (input, opts) => patchApk(input, { ...opts, keystore, registry }),
    patchLoaded: (apk, opts) => patchLoadedApk(apk, { ...opts, keystore, registry }),
    async setPacks(packs) { registry = registryWithPacks(packs.map((p) => p.pack)).registry; },
    async setModLoader(zip) { setModLoaderArtifact(parseModLoaderZip(zip)); },
    getOrCreateIdentity: () => getOrCreateIdentity(keystore),
    generateIdentity: () => generateIdentity(),
    exportIdentityJson,
    exportIdentityEncryptedJson,
    importIdentity
  };
}

/** SHA-256 hex of a DER certificate. */
export async function certFingerprint(der: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', der as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join(':');
}

/** Engine for the app: heavy work in a Web Worker when available, inline otherwise. */
export function createEngine(keystore: Keystore = new IndexedDbKeystore()): Engine {
  return typeof Worker === 'undefined' ? createInlineEngine(keystore) : createWorkerEngine(spawnApkWorker, keystore);
}
