// Maps engine/plugin errors to stable codes so the UI can show translated messages.
import { en } from './i18n/en';

export interface ErrorInfo { code: string; params: Record<string, string | number>; }

const PLUGIN_CODES: [RegExp, string][] = [
  [/^not_installed\b/, 'notInstalled'],
  [/^permission_denied\b/, 'permissionDenied'],
  [/^invalid_path\b/, 'invalidPath'],
  [/^io_error\b/, 'io'],
  [/^unsupported\b/, 'unsupported'],
  [/^install_conflict\b/, 'installConflict'],
  [/^install_aborted\b/, 'installAborted'],
  [/^install_storage\b/, 'installStorage'],
  [/^install_failed\b/, 'installFailed']
];

/** Classifies any thrown value: core PatchError (has a code), Kotlin plugin string, or unknown. */
export function classifyError(e: unknown): ErrorInfo {
  if (e && typeof e === 'object' && (e as { name?: string }).name === 'PatchError') {
    const pe = e as { code?: string; params?: Record<string, string | number>; message: string };
    return { code: pe.code ?? 'generic', params: { message: pe.message, ...(pe.params ?? {}) } };
  }
  const message = e instanceof Error ? e.message : String(e);
  for (const [re, code] of PLUGIN_CODES) {
    if (re.test(message)) return { code, params: { message: message.replace(/^[a-z_]+:?\s*/, '') || message } };
  }
  return { code: 'generic', params: { message } };
}

type T = (key: string, params?: Record<string, string | number>) => string;

/** Translated, user-facing text for an error. Unknown codes fall back to error.generic. */
export function describeError(t: T, e: unknown): string {
  const { code, params } = classifyError(e);
  const key = `error.${code}`;
  return key in en ? t(key, params) : t('error.generic', params);
}

/** Translated text for a patch incompatibility reason. */
export function describeReason(t: T, r: { code: string; params: Record<string, string | number> }): string {
  const key = `reason.${r.code}`;
  return key in en ? t(key, r.params) : r.code;
}
