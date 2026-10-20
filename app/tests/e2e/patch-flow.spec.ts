import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { buildSyntheticApk } from './fixture';

const apk = () => ({ name: 'synthetic.apk', mimeType: 'application/vnd.android.package-archive', buffer: Buffer.from(buildSyntheticApk()) });

async function consent(page: Page) {
  await expect(page.getByRole('dialog', { name: 'Before you start' })).toBeVisible();
  const cont = page.getByRole('button', { name: 'Continue' });
  await expect(cont).toBeDisabled();
  await page.getByRole('checkbox').check();
  await cont.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('first run asks for consent once, then the full web flow works (choose, review, patch, save)', async ({ page }) => {
  // Force the plain blob-download path (no native save dialog in headless).
  await page.addInitScript(() => { delete (window as unknown as Record<string, unknown>).showSaveFilePicker; });
  await page.goto('/');
  await consent(page);
  await expect(page.getByTestId('legal-notice')).toContainText('Not affiliated');
  await expect(page.getByRole('heading', { name: 'Choose your game' })).toBeVisible();

  await page.getByTestId('apk-input').setInputFiles(apk());
  await expect(page.getByRole('heading', { name: 'Review the fixes' })).toBeVisible();
  await expect(page.getByTestId('game-version')).toContainText('1.7.4 (1548230154)');
  await expect(page.getByText('Fix freeze on the welcome popup')).toBeVisible();
  await expect(page.getByText('A new key')).toBeVisible();

  await page.getByRole('button', { name: /^Patch game \(\d+ fix(es)?\)$/  }).click();
  await expect(page.getByRole('heading', { name: 'Your game is fixed!' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Uninstall the original game.')).toBeVisible();
  await expect(page.getByText(/Signing key: My key/)).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save patched APK' }).click()
  ]);
  expect(download.suggestedFilename()).toMatch(/patched\.apk$/);
  const files = unzipSync(new Uint8Array(readFileSync((await download.path())!)));
  expect(Object.keys(files)).toEqual(expect.arrayContaining(['META-INF/MANIFEST.MF', 'classes.dex']));
  // android:theme now references 0x01030011 (little endian data bytes 11 00 03 01).
  expect(Buffer.from(files['AndroidManifest.xml']!).includes(Buffer.from([0x11, 0x00, 0x03, 0x01]))).toBe(true);

  // Consent is remembered.
  await page.reload();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Choose your game' })).toBeVisible();
});

test('unsupported file shows the error state on the Choose step', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bhp.consent', '1'));
  await page.goto('/');
  await page.getByTestId('apk-input').setInputFiles({ name: 'photo.zip', mimeType: 'application/zip', buffer: Buffer.from('not an apk') });
  await expect(page.getByRole('alert')).toContainText('photo.zip');
});

test('theme toggle in Settings persists', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bhp.consent', '1'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('language switch to Turkish persists, including the consent dialog', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Language').selectOption('tr');
  await expect(page.getByRole('heading', { name: 'Başlamadan önce' })).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Devam' }).click();
  await expect(page.getByRole('heading', { name: 'Oyununuzu seçin' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Oyununuzu seçin' })).toBeVisible();
});

test('Russian and Kazakh: consent, plural button, Intl formats, Kazakh from Settings, persisted', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Language').selectOption('ru');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.getByRole('heading', { name: 'Прежде чем начать' })).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Продолжить' }).click();
  await expect(page.getByRole('heading', { name: 'Выберите игру' })).toBeVisible();
  await page.getByTestId('apk-input').setInputFiles(apk());
  await expect(page.getByRole('heading', { name: 'Проверьте исправления' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Применить \d+ исправлени(е|я|й)$/ })).toBeVisible();
  await expect(page.getByText(/\d,\d\s?кБ|\d+\sБ/).first()).toBeVisible();

  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByLabel('Язык').first().selectOption('kk');
  await expect(page.locator('html')).toHaveAttribute('lang', 'kk');
  await expect(page.getByRole('heading', { name: 'Баптаулар' }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ойынды таңдаңыз' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'kk');
});

test('the browser locale picks the language on first start', async ({ browser }) => {
  for (const [locale, heading] of [['kk-KZ', 'Бастамас бұрын'], ['ru-RU', 'Прежде чем начать']] as const) {
    const ctx = await browser.newContext({ locale });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await ctx.close();
  }
});

test('keys: generate, rename and export a backup', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('bhp.consent', '1'); delete (window as unknown as Record<string, unknown>).showSaveFilePicker; });
  await page.goto('/');
  await page.getByRole('button', { name: 'Keys' }).click();
  await expect(page.getByText('No signing key yet')).toBeVisible();
  await page.getByRole('button', { name: 'Generate new key' }).last().click();
  await expect(page.getByRole('heading', { name: 'My key' })).toBeVisible();
  await expect(page.getByTestId('fingerprint')).toContainText(/[0-9A-F]{2}/);
  await page.getByRole('button', { name: 'Export backup…' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save backup' }).click()]);
  expect(download.suggestedFilename()).toBe('blockheads-patcher-key.json');
});

test('narrow phone viewport: compact app bar with progress segments, no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('bhp.consent', '1'));
  await page.goto('/');
  await page.getByTestId('apk-input').setInputFiles(apk());
  await expect(page.getByRole('heading', { name: 'Review the fixes' })).toBeVisible();
  // the step names are visually hidden but still exposed to assistive tech
  await expect(page.getByRole('navigation', { name: 'Patch steps' }).getByText('Choose')).toBeAttached();
  await expect(page.getByRole('button', { name: /^Patch game \(\d+ fix(es)?\)$/  })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
