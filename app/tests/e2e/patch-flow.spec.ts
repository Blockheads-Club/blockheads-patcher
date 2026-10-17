import { expect, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { buildSyntheticApk } from './fixture';

test('web flow: choose synthetic APK, patch, sign, download', async ({ page }) => {
  // Force the plain blob-download path (no native save dialog in headless).
  await page.addInitScript(() => { delete (window as unknown as Record<string, unknown>).showSaveFilePicker; });
  await page.goto('/');
  await expect(page.getByTestId('legal-notice')).toContainText('Not affiliated');

  await page.getByTestId('apk-input').setInputFiles({
    name: 'synthetic.apk', mimeType: 'application/vnd.android.package-archive', buffer: Buffer.from(buildSyntheticApk())
  });
  await expect(page.getByTestId('game-version')).toContainText('Version 1.7.4 (code 1548230154)');
  await expect(page.getByText('Fix freeze on the welcome popup')).toBeVisible();

  await page.getByRole('button', { name: 'Patch and sign' }).click();
  await expect(page.getByRole('heading', { name: 'Patched APK is ready' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('signature-warning')).toContainText('Uninstall the original game first');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save patched APK' }).click()
  ]);
  expect(download.suggestedFilename()).toMatch(/patched\.apk$/);
  const files = unzipSync(new Uint8Array(readFileSync((await download.path())!)));
  expect(Object.keys(files)).toEqual(expect.arrayContaining(['META-INF/MANIFEST.MF', 'classes.dex']));
  // android:theme now references 0x01030011 (little endian data bytes 11 00 03 01).
  expect(Buffer.from(files['AndroidManifest.xml']!).includes(Buffer.from([0x11, 0x00, 0x03, 0x01]))).toBe(true);
});

test('language switch to Turkish persists', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Language').selectOption('tr');
  await expect(page.getByRole('heading', { name: 'Oyun APK dosyanızı seçin' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Oyun APK dosyanızı seçin' })).toBeVisible();
});
