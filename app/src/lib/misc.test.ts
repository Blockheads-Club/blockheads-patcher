import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { classifyError, describeError, describeReason } from './errors';
import { applyTheme, loadTheme } from './theme.svelte';
import { detectLanguage, setLanguage, lang, t } from './i18n';
import { get } from 'svelte/store';
import { GAME_PACKAGE } from './platform/types';
import { mockEngine, mockPatchReport, mockPlatform } from './testing';

const tt = (k: string, p?: Record<string, string | number>) => `${k}:${JSON.stringify(p ?? {})}`;

describe('errors', () => {
  test('PatchError with and without code/params', () => {
    expect(classifyError({ name: 'PatchError', code: 'x', message: 'm', params: { a: 1 } })).toEqual({ code: 'x', params: { message: 'm', a: 1 } });
    expect(classifyError({ name: 'PatchError', message: 'm' })).toEqual({ code: 'generic', params: { message: 'm' } });
  });
  test('plugin strings, empty remainder, non-Error values', () => {
    expect(classifyError(new Error('not_installed: nope')).code).toBe('notInstalled');
    expect(classifyError('io_error').params.message).toBe('io_error');
    expect(classifyError(42)).toEqual({ code: 'generic', params: { message: '42' } });
    expect(classifyError(null).code).toBe('generic');
  });
  test('a patch that cannot be updated in place has its own message', () => {
    const e = Object.assign(new Error('x'), { name: 'PatchError', code: 'needsOriginal', params: { id: 'doc' } });
    expect(describeError(tt, e)).toContain('error.needsOriginal');
  });
  test('describeError falls back to generic for unknown codes', () => {
    expect(describeError(tt, { name: 'PatchError', code: 'bogus', message: 'm' })).toContain('error.generic');
    expect(describeError(tt, new Error('x'))).toContain('error.generic');
    expect(describeError(tt, { name: 'PatchError', code: 'notInstalled', message: 'm' })).toContain('error.notInstalled');
  });
  test('describeReason', () => {
    expect(describeReason(tt, { code: 'nope', params: {} })).toBe('nope');
    const en = describeReason(tt, { code: 'unsupportedVersion', params: {} });
    expect(en === 'unsupportedVersion' || en.startsWith('reason.')).toBe(true);
  });
});

describe('theme', () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-theme'); });
  afterEach(() => vi.restoreAllMocks());
  test('load', () => {
    expect(loadTheme()).toBe('system');
    localStorage.setItem('bhp.theme', 'dark');
    expect(loadTheme()).toBe('dark');
    localStorage.setItem('bhp.theme', 'light');
    expect(loadTheme()).toBe('light');
  });
  test('load survives storage errors', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('x'); });
    expect(loadTheme()).toBe('system');
  });
  test('apply', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('bhp.theme')).toBe('dark');
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem('bhp.theme')).toBeNull();
  });
  test('apply survives storage errors', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('x'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('x'); });
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('i18n', () => {
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
  test('detect from storage, navigator, fallback', () => {
    localStorage.setItem('bhp.lang', 'tr');
    expect(detectLanguage()).toBe('tr');
    localStorage.setItem('bhp.lang', 'xx');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE', 'TR-tr']);
    expect(detectLanguage()).toBe('tr');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de', '']);
    expect(detectLanguage()).toBe('en');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['kk-KZ', 'ru-RU']);
    expect(detectLanguage()).toBe('kk');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ru_KZ']);
    expect(detectLanguage()).toBe('ru');
  });
  test('detect falls back to navigator.language and survives storage errors', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('x'); });
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(undefined as never);
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('tr-TR');
    expect(detectLanguage()).toBe('tr');
  });
  test('detect with no navigator', () => {
    vi.stubGlobal('navigator', undefined);
    try { expect(detectLanguage()).toBe('en'); } finally { vi.unstubAllGlobals(); }
  });
  test('setLanguage ignores unknown, survives storage errors, t interpolates', () => {
    setLanguage('zz');
    expect(get(lang)).not.toBe('zz');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('x'); });
    setLanguage('en');
    const f = get(t);
    expect(f('no.such.key')).toBe('no.such.key');
    expect(f('review.detected', { version: 'a' })).toContain('a');
    expect(f('review.detected', {})).toContain('{version}');
  });
});

test('testing helpers', async () => {
  expect(GAME_PACKAGE).toBe('com.noodlecake.blockheads');
  const e = mockEngine();
  const p = mockPatchReport('applied') as never as { patch: { detect(): string; apply(): void } }[];
  p[0]!.patch.apply();
  expect(p[0]!.patch.detect()).toBe('applied');
  const pf = mockPlatform();
  expect(await pf.pickApk()).toBeNull();
  await pf.saveOutput('a', new Uint8Array());
  const cb = vi.fn();
  await e.patchApk({} as never, { patchIds: ['a'], onProgress: cb } as never);
  await e.patchLoaded({} as never, { patchIds: ['a'], onProgress: cb } as never);
  expect(cb).toHaveBeenCalledTimes(2);
  await e.keystore.set({ certificateDer: new Uint8Array() } as never);
  await e.keystore.clear();
  await e.getOrCreateIdentity();
  await e.generateIdentity();
  await e.importIdentity('{"version":1}');
  await expect(e.importIdentity('zzz')).rejects.toThrow();
  expect(await e.exportIdentityEncryptedJson({} as never, 'p')).toBeTruthy();
});
