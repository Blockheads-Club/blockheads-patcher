// i18n scaffolding. Contract in docs/ARCHITECTURE.md section 6.
import { derived, writable } from 'svelte/store';
import { en, type MessageKey } from './en';
import { tr } from './tr';
import { numberLocale } from '../format';
import { ru } from './ru';
import { kk } from './kk';

export type { MessageKey };
export const dictionaries: Record<string, Record<MessageKey, string>> = { en, tr, ru, kk };
/** Native names, in picker order. */
export const languageNames: Record<string, string> = { en: 'English', tr: 'Türkçe', ru: 'Русский', kk: 'Қазақша' };
const STORAGE_KEY = 'bhp.lang';

export function detectLanguage(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in dictionaries) return saved;
  } catch {}
  const nav = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [];
  for (const l of nav) {
    const base = l.toLowerCase().split(/[-_]/)[0]!;
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

/** Messages that do not come with the app (texts of imported patch packs), by language; looked up after the dictionaries. */
const extra = writable<Record<string, Record<string, string>>>({});
export function setExtraMessages(messages: Record<string, Record<string, string>>): void {
  extra.set(messages);
}

type Params = Record<string, string | number>;
const PLURAL = /\{(\w+), plural,((?:\s*(?:=\d+|zero|one|two|few|many|other)\s*\{[^{}]*\})+)\s*\}/g;
const BRANCH = /(=\d+|zero|one|two|few|many|other)\s*\{([^{}]*)\}/g;

/**
 * Fills `{name}` placeholders and ICU-style plurals, `{n, plural, one {# fix} few {# …} other {# fixes}}`: an exact
 * `=N` branch wins, then the CLDR category of `locale` (Intl.PluralRules), then `other`; `#` is the locale-formatted
 * number.
 */
export function formatMessage(raw: string, params: Params | undefined, locale: string): string {
  if (!params) return raw;
  return raw
    .replace(PLURAL, (_, k: string, body: string) => {
      const n = Number(params[k]);
      const forms: Record<string, string> = Object.fromEntries([...body.matchAll(BRANCH)].map((m) => [m[1], m[2]]));
      const text = forms[`=${n}`] ?? forms[new Intl.PluralRules(locale).select(n)] ?? forms.other ?? '';
      return text.replace(/#/g, new Intl.NumberFormat(numberLocale(locale)).format(n));
    })
    .replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

/** $t('key', {name: 'x'}) -> string with {name} interpolation and plurals. Falls back to en, then key. */
export const t = derived([lang, extra], ([$lang, $extra]) => (key: MessageKey | (string & {}), params?: Params) => {
  const own = dictionaries[$lang]?.[key as MessageKey] ?? $extra[$lang]?.[key];
  const raw = own ?? en[key as MessageKey] ?? $extra.en?.[key] ?? key;
  return formatMessage(raw, params, own === undefined ? 'en' : $lang);
});
