// UI-thread side of the APK worker: an Engine whose heavy work (load, patch, sign) runs in a Web Worker.
import {
  CancelledError, PatchError, defaultRegistry, exportIdentityJson, exportIdentityEncryptedJson, generateIdentity,
  getOrCreateIdentity, importIdentity, IndexedDbKeystore, type Keystore, type LoadedApk
} from '@bh-patcher/core';
import type { ApplicableReport, Engine, PatchApkResult } from '../engine';
import type { ReportRow, Request, Response, WireError } from './protocol';

/** The subset of Worker the client needs (lets tests substitute an in-process loopback). */
export interface WorkerLike {
  postMessage(msg: Request, transfer?: Transferable[]): void;
  onmessage: ((e: { data: Response }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
  onmessageerror?: (() => void) | null;
  terminate(): void;
}

interface Pending {
  resolve(r: Response): void;
  reject(e: unknown): void;
  onProgress?(stage: Extract<Response, { t: 'progress' }>['stage'], fraction: number): void;
}

function fromWire(e: WireError): Error {
  if (e.name === 'CancelledError') return new CancelledError();
  if (e.name === 'PatchError') {
    const { message, ...rest } = e.params ?? {};
    void message;
    return new PatchError(e.message, e.code as never, rest);
  }
  const err = new Error(e.message);
  err.name = e.name;
  return err;
}

interface Handle { handle: number; rows: ReportRow[]; gen: number }

export function createWorkerEngine(spawn: () => WorkerLike, keystore: Keystore = new IndexedDbKeystore()): Engine {
  let worker: WorkerLike | null = null;
  let nextId = 1;
  /** Bumped whenever the worker dies; handle numbers restart in a fresh worker, so older handles are stale. */
  let generation = 0;
  const pending = new Map<number, Pending>();
  const handles = new WeakMap<object, Handle>();

  function failAll(err: unknown): void {
    worker?.terminate();
    worker = null;
    generation++;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  function ensure(): WorkerLike {
    if (worker) return worker;
    const w = spawn();
    w.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      if (data.t === 'progress') { p.onProgress?.(data.stage, data.fraction); return; }
      pending.delete(data.id);
      if (data.t === 'error') p.reject(fromWire(data.error));
      else p.resolve(data);
    };
    w.onerror = (e) => failAll(new Error(e.message || 'worker failed'));
    w.onmessageerror = () => failAll(new Error('worker message could not be deserialized'));
    worker = w;
    return w;
  }

  /** Posts a request and resolves with its (non-progress) response. */
  function send(req: Request & { id: number }, transfer: Transferable[] = [], onProgress?: Pending['onProgress']): Promise<Response> {
    return new Promise((resolve, reject) => {
      pending.set(req.id, { resolve, reject, onProgress });
      try { ensure().postMessage(req, transfer); } catch (e) { pending.delete(req.id); reject(e); }
    });
  }

  const handleOf = (apk: LoadedApk): Handle => {
    const h = handles.get(apk);
    if (!h) throw new Error('APK was not loaded by this engine');
    if (h.gen !== generation) throw new Error('APK handle is stale: the worker was restarted');
    return h;
  };

  /** The input buffer is transferred (zero-copy) when the view covers it exactly; otherwise copied. */
  function transferable(bytes: Uint8Array): Uint8Array {
    const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer;
    return exact ? bytes : bytes.slice();
  }

  async function loadApk(bytes: Uint8Array): Promise<LoadedApk> {
    const b = transferable(bytes);
    const r = (await send({ t: 'load', id: nextId++, bytes: b }, [b.buffer])) as Extract<Response, { t: 'loaded' }>;
    const apk = { info: r.info } as unknown as LoadedApk;
    handles.set(apk, { handle: r.handle, rows: r.rows, gen: generation });
    return apk;
  }

  async function patchLoaded(apk: LoadedApk, opts: Parameters<Engine['patchLoaded']>[1]): Promise<PatchApkResult> {
    const h = handleOf(apk);
    if (opts.signal?.aborted) throw new CancelledError();
    const identity = await getOrCreateIdentity(keystore);
    if (opts.signal?.aborted) throw new CancelledError();
    const id = nextId++;
    const onAbort = () => { worker?.postMessage({ t: 'cancel', id }); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const r = (await send({ t: 'patch', id, handle: h.handle, patchIds: opts.patchIds, identity }, [], opts.onProgress)) as Extract<Response, { t: 'patched' }>;
      return { bytes: r.bytes, applied: r.applied, skipped: r.skipped, info: r.info, certSha256: r.certSha256, suggestedFileName: r.suggestedFileName };
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  function releaseApk(apk: LoadedApk): void {
    const h = handles.get(apk);
    if (h && h.gen === generation) worker?.postMessage({ t: 'release', handle: h.handle });
  }

  return {
    keystore,
    loadApk,
    listPatches(apk): ApplicableReport {
      return handleOf(apk).rows.map((row) => {
        const patch = defaultRegistry.get(row.id)!;
        const out: ApplicableReport[number] = { patch, status: row.status };
        if (row.reason !== undefined) out.reason = row.reason;
        if (row.reasonCode !== undefined) out.reasonCode = row.reasonCode;
        return out;
      });
    },
    patchLoaded,
    async patchApk(input, opts) {
      const apk = await loadApk(input);
      try { return await patchLoaded(apk, opts); } finally { releaseApk(apk); }
    },
    async reload(apk) {
      const h = handleOf(apk);
      const r = (await send({ t: 'reload', id: nextId++, handle: h.handle })) as Extract<Response, { t: 'reloaded' }>;
      h.rows = r.rows;
      return apk;
    },
    release: releaseApk,
    getOrCreateIdentity: () => getOrCreateIdentity(keystore),
    generateIdentity: () => generateIdentity(),
    exportIdentityJson,
    exportIdentityEncryptedJson,
    importIdentity
  };
}
