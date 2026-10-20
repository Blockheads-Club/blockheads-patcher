import { expect, test } from 'vitest';
import { get } from 'svelte/store';
import { en } from './en';
import { ru } from './ru';
import { t, setLanguage, lang, dictionaries, formatMessage, languageNames } from './index';
import { classifyError, describeError } from '../errors';

const locales = Object.keys(dictionaries).filter((l) => l !== 'en');
const ph = (s: string) => [...s.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]).sort().join();
const plurals = (s: string) => [...s.matchAll(/\{\w+, plural,((?:\s*[=\w]+\s*\{[^{}]*\})+)\s*\}/g)].map((m) => [...m[1]!.matchAll(/([=\w]+)\s*\{/g)].map((b) => b[1]!));

test.each(locales)('%s has exactly the en keys', (l) => {
  expect(Object.keys(dictionaries[l]!).sort()).toEqual(Object.keys(en).sort());
});
test.each(locales)('%s keeps the placeholders and plural frames of en', (l) => {
  for (const k of Object.keys(en) as (keyof typeof en)[]) {
    expect(ph(dictionaries[l]![k]), k).toBe(ph(en[k]));
    expect(plurals(dictionaries[l]![k]).length, k).toBe(plurals(en[k]).length);
  }
});
test.each(Object.keys(dictionaries))('%s plurals use only its CLDR categories and always have other', (l) => {
  const cats = new Intl.PluralRules(l).resolvedOptions().pluralCategories as string[];
  for (const [k, v] of Object.entries(dictionaries[l]!))
    for (const forms of plurals(v)) {
      expect(forms, k).toContain('other');
      for (const f of forms) expect(f.startsWith('=') || cats.includes(f), `${k}: ${f}`).toBe(true);
    }
});
test('Russian plurals give one, few and many', () => {
  for (const [k, v] of Object.entries(ru)) for (const forms of plurals(v)) expect(forms, k).toEqual(expect.arrayContaining(['one', 'few', 'many', 'other']));
  setLanguage('ru');
  const tt = get(t);
  expect([1, 3, 5, 21, 1000].map((n) => tt('packs.count', { n }).replace(/[\u00a0\u202f]/g, ' '))).toEqual(['1 патч', '3 патча', '5 патчей', '21 патч', '1 000 патчей']);
  setLanguage('kk');
  expect(get(t)('packs.count', { n: 3 })).toMatch(/^3 /);
  setLanguage('en');
  expect([1, 2, 1000].map((n) => get(t)('packs.count', { n }))).toEqual(['1 patch', '2 patches', '1,000 patches']);
});
test('formatMessage: exact branches, missing categories, unknown params', () => {
  expect(formatMessage('{n, plural, =0 {none} one {# x} other {# xs}}', { n: 0 }, 'en')).toBe('none');
  expect(formatMessage('{n, plural, other {# yama}}', { n: 1 }, 'tr')).toBe('1 yama');
  expect(formatMessage('{n, plural, one {# x}}', { n: 2 }, 'en')).toBe('');
  expect(formatMessage('{a} {b}', { a: 1 }, 'en')).toBe('1 {b}');
  expect(formatMessage('{n, plural, one {x}}', undefined, 'en')).toBe('{n, plural, one {x}}');
});
test('language names are native and in picker order', () => {
  expect(languageNames).toEqual({ en: 'English', tr: 'Türkçe', ru: 'Русский', kk: 'Қазақша' });
});
test('required keys exist', () => {
  for (const k of ['app.title', 'legal.notice', 'drop.browse', 'installed.use', 'review.patchesFor', 'badge.applied',
    'result.save', 'swap.s1Button', 'swap.s2Button', 'keys.title', 'keys.export', 'keys.import', 'keys.generate', 'error.generic',
    'patch.fix-welcome-popup-deadlock.name', 'patch.fix-welcome-popup-deadlock.summary', 'patch.fix-system-font-crash.summary'])
    expect(k in en, k).toBe(true);
});
test('interpolation, language switch and persistence', () => {
  setLanguage('tr');
  expect(get(lang)).toBe('tr');
  expect(get(t)('review.detected', { version: '1.7.4' })).toBe('1.7.4 sürümü bulundu');
  expect(localStorage.getItem('bhp.lang')).toBe('tr');
  setLanguage('xx');
  expect(get(lang)).toBe('tr');
  setLanguage('en');
  expect(get(t)('unknown.key')).toBe('unknown.key');
});

test('every error and reason code has a translation key in every language', () => {
  const errorCodes = ['notApk', 'noManifest', 'unknownPatch', 'cannotApply', 'duplicatePatch', 'notInstalled', 'permissionDenied',
    'invalidPath', 'io', 'unsupported', 'installConflict', 'installAborted', 'installStorage', 'installFailed', 'generic'];
  const reasons = ['wrongPackage', 'versionTooLow', 'versionTooHigh', 'versionNotSupported'];
  for (const d of Object.values(dictionaries)) {
    for (const c of errorCodes) expect(`error.${c}` in d, c).toBe(true);
    for (const c of reasons) expect(`reason.${c}` in d, c).toBe(true);
  }
});
test('plugin and core errors are classified and translated', () => {
  setLanguage('tr');
  const tt = get(t);
  expect(classifyError('not_installed').code).toBe('notInstalled');
  expect(classifyError('io_error: boom').code).toBe('io');
  expect(classifyError('install_conflict: x').code).toBe('installConflict');
  const pe = Object.assign(new Error('not an APK: x'), { name: 'PatchError', code: 'notApk', params: { message: 'x' } });
  expect(describeError(tt, pe)).toBe('Bu dosya geçerli bir APK değil (x).');
  expect(describeError(tt, new Error('weird'))).toBe('Bir şeyler ters gitti: weird');
  setLanguage('en');
});
