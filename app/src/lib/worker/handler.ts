// Worker-side request handler. Kept free of `self` so it can be driven directly in tests.
import {
  loadApk, listPatches, patchLoadedApk, MemoryKeystore, PatchError, defaultRegistry, loadPack, registryWithPacks,
  parseModLoaderZip, setModLoaderArtifact,
  type LoadedApk, type PatchRegistry
} from '@bh-patcher/core';
import type { ReportRow, Request, Response, WireError } from './protocol';

interface Held { bytes: Uint8Array; apk: LoadedApk; dirty?: boolean }

function toWire(e: unknown): WireError {
  if (e instanceof PatchError) return { name: e.name, message: e.message, code: e.code, params: e.params };
  if (e instanceof Error) return { name: e.name, message: e.message };
  return { name: 'Error', message: String(e) };
}

const rowsOf = (apk: LoadedApk, registry: PatchRegistry): ReportRow[] =>
  listPatches(apk, registry).map((r) => {
    const row: ReportRow = { id: r.patch.id, status: r.status };
    if (r.reason !== undefined) row.reason = r.reason;
    if (r.reasonCode !== undefined) row.reasonCode = r.reasonCode;
    if (r.fromVersion !== undefined) row.fromVersion = r.fromVersion;
    if (r.canUpgrade !== undefined) row.canUpgrade = r.canUpgrade;
    return row;
  });

/** Returns the message handler. `post(msg, transfer)` sends a response to the UI thread. */
export function createHandler(post: (msg: Response, transfer?: Transferable[]) => void): (req: Request) => Promise<void> {
  const held = new Map<number, Held>();
  const jobs = new Map<number, AbortController>();
  let nextHandle = 1;
  let registry: PatchRegistry = defaultRegistry;

  /** Synchronous, so requests posted after it (load, patch) always see the new registry. */
  function setPacks(req: Extract<Request, { t: 'packs' }>): void {
    const packs = req.packs.map((b) => {
      const r = loadPack(b);
      if (!r.ok) throw new Error(`invalid pack: ${r.errors[0]!.message}`);
      return r.pack;
    });
    registry = registryWithPacks(packs).registry;
    post({ t: 'packs', id: req.id });
  }

  async function load(req: Extract<Request, { t: 'load' }>): Promise<void> {
    const apk = await loadApk(req.bytes);
    const handle = nextHandle++;
    held.set(handle, { bytes: req.bytes, apk });
    post({ t: 'loaded', id: req.id, handle, info: apk.info, rows: rowsOf(apk, registry) });
  }

  /** Restores a possibly half-patched archive from the retained input, lazily and at most once per failure. */
  async function restore(handle: number, h: Held): Promise<void> {
    if (!h.dirty) return;
    try {
      h.apk = await loadApk(h.bytes);
      h.dirty = false;
    } catch (e) {
      held.delete(handle);
      throw e;
    }
  }

  async function reload(req: Extract<Request, { t: 'reload' }>): Promise<void> {
    const h = held.get(req.handle);
    if (!h) throw new Error('unknown APK handle');
    await restore(req.handle, h);
    post({ t: 'reloaded', id: req.id, rows: rowsOf(h.apk, registry) });
  }

  async function patch(req: Extract<Request, { t: 'patch' }>): Promise<void> {
    const h = held.get(req.handle);
    if (!h) throw new Error('unknown APK handle');
    await restore(req.handle, h);
    const ctl = new AbortController();
    jobs.set(req.id, ctl);
    const keystore = new MemoryKeystore();
    await keystore.set(req.identity);
    try {
      const r = await patchLoadedApk(h.apk, {
        patchIds: req.patchIds, keystore, registry, signal: ctl.signal,
        onProgress: (stage, fraction) => post({ t: 'progress', id: req.id, stage, fraction })
      });
      held.delete(req.handle); // the archive was consumed; the UI drops its handle after a successful patch
      const out = r.bytes.byteLength === r.bytes.buffer.byteLength ? r.bytes : r.bytes.slice();
      post({ t: 'patched', id: req.id, bytes: out, applied: r.applied, upgraded: r.upgraded, skipped: r.skipped, info: r.info, certSha256: r.certSha256, suggestedFileName: r.suggestedFileName }, [out.buffer]);
    } catch (e) {
      h.dirty = true; // the archive may be half-patched: it is re-parsed once, by the next reload or patch
      throw e;
    } finally {
      jobs.delete(req.id);
    }
  }

  return async (req) => {
    if (req.t === 'cancel') { jobs.get(req.id)?.abort(); return; }
    if (req.t === 'release') { held.delete(req.handle); return; }
    try {
      if (req.t === 'packs') setPacks(req);
      else if (req.t === 'modLoader') { setModLoaderArtifact(parseModLoaderZip(req.zip)); post({ t: 'modLoader', id: req.id }); }
      else if (req.t === 'load') await load(req);
      else if (req.t === 'reload') await reload(req);
      else await patch(req);
    } catch (e) {
      post({ t: 'error', id: req.id, error: toWire(e) });
    }
  };
}
