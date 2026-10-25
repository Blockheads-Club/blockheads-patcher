import { throwIfCancelled } from './abort';
import { parseAxml, manifestInfo, serializeAxml, type AxmlDocument } from './axml';
import { getOrCreateIdentity, signZip, type Keystore } from './signing';
import { defaultRegistry, PatchError, type ApkInfo, type Patch, type PatchContext, type PatchReason, type PatchRegistry, type PatchStatus } from './patches';
import { DexCache } from './patches/dex-support';
import { comparePatchVersions } from './patches/versioning';
import { readRecord, writeRecord, type PatcherRecord } from './record';
import { CORE_VERSION } from './version';
import { getEntry, readZip, removeSignatureFiles, setEntry, sourceSha256, type ZipArchive } from './zip';

export interface LoadedApk {
  zip: ZipArchive;
  manifest: AxmlDocument;
  info: ApkInfo;
  /** Set once a patch changed the manifest. */
  manifestDirty?: boolean;
  /** What an earlier Patcher run recorded in the APK (undefined for an APK without a record). */
  record?: PatcherRecord;
}
export interface ReportRow {
  patch: Patch;
  status: PatchStatus;
  reason?: string;
  reasonCode?: PatchReason;
  /** `outdated` only: the version of the output in the APK, when known (the record or the content says). */
  fromVersion?: number;
  /** `outdated` only: false when the patch has no upgrade hook (it needs the original game APK). */
  canUpgrade?: boolean;
}
export type ApplicableReport = ReportRow[];
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
  const record = readRecord(zip);
  sourceSha256.set(zip, info.sha256);
  if (mi.versionName !== undefined) info.versionName = mi.versionName;
  if (mi.versionCode !== undefined) info.versionCode = mi.versionCode;
  return record ? { zip, manifest, info, record } : { zip, manifest, info };
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

interface Resolved { status: PatchStatus; from?: number }

/**
 * The status of one patch in this APK. `detect` looks at the content; an older output is recognised by the patch itself
 * (`outdated` or `installedVersion`) or by the record an earlier run left (the record names a version below the current
 * one while the content does not show the current output). Without such evidence nothing is claimed to be outdated.
 */
function resolve(patch: Patch, ctx: PatchContext, record: PatcherRecord | undefined): Resolved {
  const s = patch.detect(ctx);
  if (s === 'applied') return { status: 'applied' };
  const from = patch.installedVersion?.(ctx) ?? record?.patches[patch.id];
  if (s === 'outdated' || (from !== undefined && comparePatchVersions(from, patch.version) < 0)) {
    return from === undefined ? { status: 'outdated' } : { status: 'outdated', from };
  }
  return { status: s };
}

export function listPatches(apk: LoadedApk, registry: PatchRegistry = defaultRegistry): ApplicableReport {
  const ctx = { ...makeContext(apk), dexCache: new DexCache() };
  return registry.list().map((patch): ReportRow => {
    const bad = incompatibility(patch, apk.info);
    if (bad) return { patch, status: 'incompatible', reason: bad.message, reasonCode: bad.reasonCode };
    const r = resolve(patch, ctx, apk.record);
    ctx.dexCache.check();
    if (r.status !== 'outdated') return { patch, status: r.status };
    return { patch, status: 'outdated', ...(r.from !== undefined ? { fromVersion: r.from } : {}), canUpgrade: !!patch.upgrade };
  });
}

export function applyPatches(apk: LoadedApk, patchIds: string[], registry: PatchRegistry = defaultRegistry) {
  const applied: string[] = [];
  const upgraded: string[] = [];
  const skipped: { id: string; status: PatchStatus }[] = [];
  const ctx = makeContext(apk);
  for (const id of patchIds) {
    const patch = registry.get(id);
    if (!patch) throw new PatchError(`unknown patch: ${id}`, 'unknownPatch', { id });
    const r: Resolved = incompatibility(patch, apk.info) ? { status: 'incompatible' } : resolve(patch, ctx, apk.record);
    if (r.status === 'outdated') {
      if (!patch.upgrade) {
        throw new PatchError(`${id} has an older output in this APK and cannot be updated in place: it needs the original game APK`, 'needsOriginal', { id });
      }
      patch.upgrade(ctx, r.from);
      upgraded.push(id);
      applied.push(id);
    } else if (r.status === 'notApplied') {
      patch.apply(ctx);
      applied.push(id);
    } else skipped.push({ id, status: r.status });
  }
  return { applied, upgraded, skipped };
}

/**
 * The record for the APK as it is after patching: every patch whose current output is in the APK at its current version,
 * an older output at the version found (when known), plus entries of patches this registry does not know.
 */
export function buildRecord(apk: LoadedApk, registry: PatchRegistry = defaultRegistry): PatcherRecord {
  const ctx = { ...makeContext(apk), dexCache: new DexCache() };
  const patches: Record<string, number> = { ...apk.record?.patches };
  for (const patch of registry.list()) {
    if (incompatibility(patch, apk.info)) continue;
    const r = resolve(patch, ctx, apk.record);
    ctx.dexCache.check();
    if (r.status === 'applied') patches[patch.id] = patch.version;
    else if (r.status === 'outdated' && r.from !== undefined) patches[patch.id] = r.from;
    else if (r.status !== 'incompatible') delete patches[patch.id];
  }
  return { schema: 1, patcher: CORE_VERSION, patches };
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
  /** The subset of `applied` that updated an older output instead of applying fresh. */
  upgraded: string[];
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
  const { applied, upgraded, skipped } = applyPatches(apk, opts.patchIds, opts.registry);
  progress('patch', 1);
  if (apk.manifestDirty) setEntry(apk.zip, { name: 'AndroidManifest.xml', data: serializeAxml(apk.manifest) });
  writeRecord(apk.zip, buildRecord(apk, opts.registry));
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
  return { bytes, applied, upgraded, skipped, info: apk.info, certSha256, suggestedFileName: `${base}${version}-patched.apk` };
}
