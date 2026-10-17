import { expect, test } from 'vitest';
import { get } from 'svelte/store';
import { en } from './en';
import { tr } from './tr';
import { t, setLanguage, lang } from './index';
import { classifyError, describeError } from '../errors';

test('tr has every en key', () => {
  expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
});
test('placeholders match between en and tr', () => {
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  for (const k of Object.keys(en) as (keyof typeof en)[]) expect(ph(tr[k]), k).toBe(ph(en[k]));
});
test('required keys exist', () => {
  for (const k of ['app.title', 'legal.notice', 'drop.browse', 'installed.use', 'review.patchesFor', 'badge.applied',
    'result.save', 'swap.s1Button', 'swap.s2Button', 'keys.title', 'keys.export', 'keys.import', 'keys.generate', 'error.generic',
    'patch.fix-welcome-popup-deadlock.name', 'patch.fix-welcome-popup-deadlock.summary', 'patch.fix-iap-store-font-crash.summary'])
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

test('every error and reason code has a translation key in en and tr', () => {
  const errorCodes = ['notApk', 'noManifest', 'unknownPatch', 'cannotApply', 'duplicatePatch', 'notInstalled', 'permissionDenied',
    'invalidPath', 'io', 'unsupported', 'installConflict', 'installAborted', 'installStorage', 'installFailed', 'generic'];
  const reasons = ['wrongPackage', 'versionTooLow', 'versionTooHigh', 'versionNotSupported'];
  for (const c of errorCodes) { expect(`error.${c}` in en, c).toBe(true); expect(`error.${c}` in tr, c).toBe(true); }
  for (const c of reasons) { expect(`reason.${c}` in en, c).toBe(true); expect(`reason.${c}` in tr, c).toBe(true); }
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
