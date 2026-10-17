import type { AxmlDocument } from '../axml';
import type { ZipArchive } from '../zip';

export interface ApkInfo {
  packageName: string;
  versionName?: string;
  versionCode?: number;
  /** Hex SHA-256 of the input file. */
  sha256: string;
}
export type PatchStatus = 'applied' | 'notApplied' | 'incompatible';
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
}
export interface Patch {
  id: string;
  version: number;
  nameKey: string;
  descriptionKey: string;
  appliesTo: PatchAppliesTo;
  /** Pure: must not mutate the context. */
  detect(ctx: PatchContext): PatchStatus;
  /** Throws PatchError if detect() !== 'notApplied'. */
  apply(ctx: PatchContext): void;
}
/** Stable machine-readable error codes so UIs can show translated messages. */
export type PatchErrorCode = 'notApk' | 'noManifest' | 'unknownPatch' | 'cannotApply' | 'duplicatePatch' | 'generic';
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
