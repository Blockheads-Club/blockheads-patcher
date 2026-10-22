// Message protocol between the UI thread and the APK worker. Everything here is structured-cloneable.
import type { ApkInfo, PatchReason, PatchStatus, SigningIdentity } from '@bh-patcher/core';

export type ProgressStage = 'read' | 'parse' | 'patch' | 'write' | 'sign' | 'done';

/** Serializable form of one ApplicableReport row (the Patch object itself holds functions). */
export interface ReportRow { id: string; status: PatchStatus; reason?: string; reasonCode?: PatchReason }

export interface WireError { name: string; message: string; code?: string; params?: Record<string, string | number> }

export type Request =
  /** `bytes` is transferred; the worker keeps it so a failed or cancelled patch can re-parse. */
  | { t: 'load'; id: number; bytes: Uint8Array }
  | { t: 'patch'; id: number; handle: number; patchIds: string[]; identity: SigningIdentity }
  | { t: 'reload'; id: number; handle: number }
  | { t: 'cancel'; id: number }
  /** Replaces the imported packs (raw .bhpack files, validated again here); answered with `packs`. */
  | { t: 'packs'; id: number; packs: Uint8Array[] }
  /** The pinned mod loader zip (checked again here) for the mod-loader patch; answered with `modLoader`. */
  | { t: 'modLoader'; id: number; zip: Uint8Array }
  | { t: 'release'; handle: number };

export type Response =
  | { t: 'loaded'; id: number; handle: number; info: ApkInfo; rows: ReportRow[] }
  | { t: 'reloaded'; id: number; rows: ReportRow[] }
  | { t: 'packs'; id: number }
  | { t: 'modLoader'; id: number }
  | { t: 'progress'; id: number; stage: ProgressStage; fraction: number }
  | { t: 'patched'; id: number; bytes: Uint8Array; applied: string[]; skipped: { id: string; status: PatchStatus }[]; info: ApkInfo; certSha256: string; suggestedFileName: string }
  | { t: 'error'; id: number; error: WireError };
