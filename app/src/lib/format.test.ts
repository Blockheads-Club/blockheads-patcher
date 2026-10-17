import { expect, test } from 'vitest';
import { formatBytes, formatClock, formatDate, shortFingerprint } from './format';
import { completedRows, overallPercent } from './progress';
import { copyText } from './clipboard';
import { vi } from 'vitest';
import { Prefs, giveConsent, hasConsent } from './prefs.svelte';

test('formatBytes', () => {
  expect(formatBytes(12, 'en')).toBe('12 B');
  expect(formatBytes(61_300_000, 'en')).toBe('61.3 MB');
  expect(formatBytes(5_000_000_000_000, 'en')).toBe('5,000 GB');
});
test('formatDate / formatClock / shortFingerprint', () => {
  expect(formatDate(Date.UTC(2026, 9, 12, 12), 'en')).toContain('2026');
  expect(formatClock(new Date(2026, 0, 1, 3, 4, 5))).toBe('03:04:05');
  expect(shortFingerprint('AA:BB:CC:DD:EE', 2, 1)).toBe('AA:BB…EE');
  expect(shortFingerprint('AA:BB')).toBe('AA:BB');
});
test('progress mapping', () => {
  expect(completedRows('read', 0)).toBe(0);
  expect(completedRows('parse', 1)).toBe(1);
  expect(completedRows('patch', 1)).toBe(2);
  expect(completedRows('write', 1)).toBe(3);
  expect(completedRows('sign', 0.5)).toBe(3);
  expect(completedRows('sign', 1)).toBe(4);
  expect(completedRows('done', 1)).toBe(4);
  expect(overallPercent('read', 0)).toBe(0);
  expect(overallPercent('parse', 1)).toBe(10);
  expect(overallPercent('patch', 1)).toBe(35);
  expect(overallPercent('write', 1)).toBe(45);
  expect(overallPercent('sign', 0.5)).toBe(73);
  expect(overallPercent('sign', 9)).toBe(100);
  expect(overallPercent('done', 1)).toBe(100);
});
test('copyText', async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  expect(await copyText('x')).toBe(true);
  writeText.mockRejectedValueOnce(new Error('no'));
  expect(await copyText('x')).toBe(false);
});
test('prefs and consent persist and survive storage errors', () => {
  localStorage.clear();
  expect(hasConsent()).toBe(false);
  giveConsent();
  expect(hasConsent()).toBe(true);
  const p = new Prefs();
  expect(p.showLog).toBe(true);
  p.setShowLog(false);
  expect(new Prefs().showLog).toBe(false);
  p.setShowLog(true);
  expect(new Prefs().showLog).toBe(true);
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('x'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('x'); });
  expect(hasConsent()).toBe(false);
  expect(() => giveConsent()).not.toThrow();
  vi.restoreAllMocks();
});
