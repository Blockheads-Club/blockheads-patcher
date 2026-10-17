// i18n scaffolding. Contract in docs/ARCHITECTURE.md section 6.
import { derived, writable } from 'svelte/store';
import { en, type MessageKey } from './en';
import { tr } from './tr';

export type { MessageKey };
export const dictionaries: Record<string, Record<MessageKey, string>> = { en, tr };
export const languageNames: Record<string, string> = { en: 'English', tr: 'Türkçe' };
const STORAGE_KEY = 'bhp.lang';

export function detectLanguage(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in dictionaries) return saved;
  } catch {}
  const nav = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [];
  for (const l of nav) {
    const base = l.toLowerCase().split('-')[0]!;
    if (base in dictionaries) return base;
  }
  return 'en';
}

export const lang = writable<string>(detectLanguage());
export function setLanguage(code: string): void {
  if (!(code in dictionaries)) return;
  lang.set(code);
  try { localStorage.setItem(STORAGE_KEY, code); } catch {}
}

/** $t('key', {name: 'x'}) -> string with {name} interpolation. Falls back to en, then key. */
export const t = derived(lang, ($lang) => (key: MessageKey | (string & {}), params?: Record<string, string | number>) => {
  const raw = dictionaries[$lang]?.[key as MessageKey] ?? en[key as MessageKey] ?? key;
  return params ? raw.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`)) : raw;
});
