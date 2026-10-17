import { throwIfCancelled } from './abort';
import { parseAxml, manifestInfo, serializeAxml, type AxmlDocument } from './axml';
import { getOrCreateIdentity, signZip, type Keystore } from './signing';
import { defaultRegistry, PatchError, type ApkInfo, type Patch, type PatchContext, type PatchReason, type PatchRegistry, type PatchStatus } from './patches';
import { getEntry, readZip, removeSignatureFiles, setEntry, type ZipArchive } from './zip';

export interface LoadedApk {
  zip: ZipArchive;
  manifest: AxmlDocument;
  info: ApkInfo;
  /** Set once a patch changed the manifest. */
  manifestDirty?: boolean;
}
export type ApplicableReport = { patch: Patch; status: PatchStatus; reason?: string; reasonCode?: PatchReason }[];
export type Progress = (stage: 'read' | 'parse' | 'patch' | 'write' | 'sign' | 'done', fraction: number) => void;

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
async function sha256Hex(b: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)));
}

export async function loadApk(bytes: Uint8Array): Promise<LoadedApk> {
  let zip: ZipArchive;
  try {
    zip = readZip(bytes);
  } catch (e) {
    throw new PatchError(`not an APK: ${(e as Error).message}`, 'notApk', { message: (e as Error).message });
  }
  const m = getEntry(zip, 'AndroidManifest.xml');
  if (!m) throw new PatchError('no manifest: AndroidManifest.xml is missing', 'noManifest', { message: 'AndroidManifest.xml is missing' });
  let manifest: AxmlDocument;
  let mi: ReturnType<typeof manifestInfo>;
  try {
    manifest = parseAxml(m.data);
    mi = manifestInfo(manifest);
  } catch (e) {
    throw new PatchError(`no manifest: ${(e as Error).message}`, 'noManifest', { message: (e as Error).message });
  }
  const info: ApkInfo = { packageName: mi.package, sha256: await sha256Hex(bytes) };
  if (mi.versionName !== undefined) info.versionName = mi.versionName;
  if (mi.versionCode !== undefined) info.versionCode = mi.versionCode;
  return { zip, manifest, info };
}

function makeContext(apk: LoadedApk): PatchContext {
  return {
    zip: apk.zip, manifest: apk.manifest, info: apk.info,
    markManifestDirty: () => { apk.manifestDirty = true; },
    log: () => {},
  };
}

/** Returns a reason when the patch does not apply to this APK's identity, else undefined. */
function incompatibility(p: Patch, info: ApkInfo): { message: string; reasonCode: PatchReason } | undefined {
  const a = p.appliesTo;
  const r = (message: string, code: PatchReason['code'], params: PatchReason['params']) => ({ message, reasonCode: { code, params } });
  if (a.packageName !== info.packageName)
    return r(`package ${info.packageName} != ${a.packageName}`, 'wrongPackage', { actual: info.packageName, expected: a.packageName });
  const vc = info.versionCode;
  if (a.versionCode && vc !== undefined) {
    if (a.versionCode.min !== undefined && vc < a.versionCode.min)
      return r(`versionCode ${vc} < ${a.versionCode.min}`, 'versionTooLow', { actual: vc, min: a.versionCode.min });
    if (a.versionCode.max !== undefined && vc > a.versionCode.max)
      return r(`versionCode ${vc} > ${a.versionCode.max}`, 'versionTooHigh', { actual: vc, max: a.versionCode.max });
  }
  if (a.versionNames && info.versionName !== undefined && !a.versionNames.includes(info.versionName))
    return r(`versionName ${info.versionName} not supported`, 'versionNotSupported', { actual: info.versionName });
  return undefined;
}

export function listPatches(apk: LoadedApk, registry: PatchRegistry = defaultRegistry): ApplicableReport {
  const ctx = makeContext(apk);
  return registry.list().map((patch) => {
    const bad = incompatibility(patch, apk.info);
    if (bad) return { patch, status: 'incompatible' as const, reason: bad.message, reasonCode: bad.reasonCode };
    return { patch, status: patch.detect(ctx) };
  });
}

export function applyPatches(apk: LoadedApk, patchIds: string[], registry: PatchRegistry = defaultRegistry) {
  const applied: string[] = [];
  const skipped: { id: string; status: PatchStatus }[] = [];
  const ctx = makeContext(apk);
  for (const id of patchIds) {
    const patch = registry.get(id);
    if (!patch) throw new PatchError(`unknown patch: ${id}`, 'unknownPatch', { id });
    const status: PatchStatus = incompatibility(patch, apk.info) ? 'incompatible' : patch.detect(ctx);
    if (status !== 'notApplied') { skipped.push({ id, status }); continue; }
    patch.apply(ctx);
    applied.push(id);
  }
  return { applied, skipped };
}

export interface PatchApkOptions {
  patchIds: string[];
  keystore: Keystore;
  registry?: PatchRegistry;
  onProgress?: Progress;
  /** Cancels between stages and signing steps (throws CancelledError). */
  signal?: AbortSignal;
}
export interface PatchApkResult {
  bytes: Uint8Array;
  applied: string[];
  skipped: { id: string; status: PatchStatus }[];
  info: ApkInfo;
  certSha256: string;
  suggestedFileName: string;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export async function patchApk(input: Uint8Array, opts: PatchApkOptions): Promise<PatchApkResult> {
  const progress = opts.onProgress ?? (() => {});
  progress('read', 0);
  await tick();
  throwIfCancelled(opts.signal);
  const apk = await loadApk(input);
  progress('parse', 1);
  return patchLoadedApk(apk, opts);
}

/**
 * Patches an APK that was already parsed with loadApk, avoiding a second read/inflate of the archive.
 * NOTE: mutates `apk` (zip and manifest); load again if you need the original afterwards.
 */
export async function patchLoadedApk(apk: LoadedApk, opts: PatchApkOptions): Promise<PatchApkResult> {
  const progress = opts.onProgress ?? (() => {});
  await tick();
  throwIfCancelled(opts.signal);
  const { applied, skipped } = applyPatches(apk, opts.patchIds, opts.registry);
  progress('patch', 1);
  if (apk.manifestDirty) setEntry(apk.zip, { name: 'AndroidManifest.xml', data: serializeAxml(apk.manifest) });
  removeSignatureFiles(apk.zip);
  await tick();
  progress('write', 1);
  await tick();
  const identity = await getOrCreateIdentity(opts.keystore);
  const bytes = await signZip(apk.zip, { identity, signal: opts.signal, onProgress: (f) => progress('sign', f) });
  progress('sign', 1);
  const certSha256 = await sha256Hex(identity.certificateDer);
  progress('done', 1);
  const version = apk.info.versionName ? `-${apk.info.versionName}` : '';
  const base = apk.info.packageName === 'com.noodlecake.blockheads' ? 'blockheads' : apk.info.packageName;
  return { bytes, applied, skipped, info: apk.info, certSha256, suggestedFileName: `${base}${version}-patched.apk` };
}
