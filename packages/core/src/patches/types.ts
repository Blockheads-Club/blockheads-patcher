import type { DexCache } from './dex-support';
import type { AxmlDocument } from '../axml';
import type { ZipArchive } from '../zip';

export interface ApkInfo {
  packageName: string;
  versionName?: string;
  versionCode?: number;
  /** Hex SHA-256 of the input file. */
  sha256: string;
}
/**
 * `outdated`: an older output of this patch is in the APK (its version is below the patch's current one). Applying the
 * patch then runs its `upgrade` hook; a patch without one cannot be updated in place (it needs the original game APK).
 */
export type PatchStatus = 'applied' | 'notApplied' | 'incompatible' | 'outdated';
export interface PatchAppliesTo {
  packageName: string;
  versionCode?: { min?: number; max?: number };
  versionNames?: string[];
  /** Known-good input hashes (informational; not required to apply). */
  sha256?: string[];
}
/** Mutable working copy handed to patches; a patch edits it, the pipeline serializes. */
export interface PatchContext {
  zip: ZipArchive;
  manifest: AxmlDocument;
  info: ApkInfo;
  markManifestDirty(): void;
  log(msg: string): void;
  /** Detect-only contexts (listPatches) share parsed dex files between patches; see DexCache. */
  dexCache?: DexCache;
}
/** Where the idea for a patch came from (shown in the UI). */
export interface PatchCredits {
  source: string;
  url: string;
}
/** Display texts carried by the patch itself (patch packs), by language code; `en` is always present. */
export interface PatchTexts {
  name: string;
  summary: string;
  description: string;
}
/** Where a patch comes from when it is not built in. */
export interface PatchSource {
  kind: 'pack';
  packId: string;
  /** English name of the pack. */
  packName: string;
  packVersion: string;
}
/** Optional version behaviour a patch (or a patch factory's spec) can add. */
export interface PatchVersioning {
  /** Current output version (positive integer; default 1). Bump it whenever the bytes the patch writes change. */
  version?: number;
  /** Text for a version number in the UI (default `v<n>`). */
  versionLabel?(v: number): string;
  /** Content evidence of an older output: the version found in the APK, for APKs without a record. Only called when detect() is not `applied`. */
  installedVersion?(ctx: PatchContext): number | undefined;
  /** Turns the older output (version `from`, when known) into the current one. Without it the patch cannot be updated in place. */
  upgrade?(ctx: PatchContext, from: number | undefined): void;
}
export interface Patch extends Omit<PatchVersioning, 'version'> {
  id: string;
  /** Current output version, a positive integer. Bump it whenever the bytes the patch writes change (docs/development.md). */
  version: number;
  nameKey: string;
  descriptionKey: string;
  appliesTo: PatchAppliesTo;
  /** Idea/bug-list credit; the implementation is always our own. */
  credits?: PatchCredits;
  /** Not selected by default (changes behaviour more widely than a fix). */
  optIn?: boolean;
  /** Texts by language for patches whose strings are not in the app dictionaries (`nameKey` etc. are then unused keys). */
  texts?: Record<string, PatchTexts>;
  /** Set for patches imported from a patch pack. */
  source?: PatchSource;
  /** Pure: must not mutate the context. */
  detect(ctx: PatchContext): PatchStatus;
  /** Throws PatchError if detect() !== 'notApplied'. */
  apply(ctx: PatchContext): void;
}
/** Copies the optional version behaviour of a spec onto a patch built by a factory. */
export function applyVersioning(patch: Patch, v: PatchVersioning): Patch {
  if (v.version !== undefined) patch.version = v.version;
  if (v.versionLabel) patch.versionLabel = v.versionLabel;
  if (v.installedVersion) patch.installedVersion = v.installedVersion;
  if (v.upgrade) patch.upgrade = v.upgrade;
  return patch;
}
/** Stable machine-readable error codes so UIs can show translated messages. */
export type PatchErrorCode = 'notApk' | 'noManifest' | 'unknownPatch' | 'cannotApply' | 'duplicatePatch' | 'modLoaderUnavailable' | 'needsOriginal' | 'generic';
export class PatchError extends Error {
  /** `params.message` carries the untranslated technical detail. */
  readonly params: Record<string, string | number>;
  constructor(message: string, readonly code: PatchErrorCode = 'generic', params: Record<string, string | number> = {}) {
    super(message);
    this.name = 'PatchError';
    this.params = { message, ...params };
  }
}
/** Why a patch is incompatible with an APK, as a code plus parameters (for i18n). */
export interface PatchReason {
  code: 'wrongPackage' | 'versionTooLow' | 'versionTooHigh' | 'versionNotSupported';
  params: Record<string, string | number>;
}
export interface PatchRegistry {
  register(p: Patch): void;
  get(id: string): Patch | undefined;
  list(): Patch[];
}
