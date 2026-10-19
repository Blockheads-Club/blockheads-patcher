import { expect, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildPackArchive } from '../../../packages/core/src/packs/build';
import { buildSyntheticApk } from './fixture';

/** The example pack from examples/packs, zipped the way scripts/build-pack.ts does it. */
function examplePack(): Buffer {
  const dir = new URL('../../../examples/packs/example-label/', import.meta.url).pathname;
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else files[relative(dir, p)] = new Uint8Array(readFileSync(p));
    }
  };
  walk(dir);
  return Buffer.from(buildPackArchive(files));
}

test('an imported pack is kept across reloads and its patches can be applied', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('bhp.consent', '1');
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('Packs come from other people')).toBeVisible();
  await page.getByTestId('pack-input').setInputFiles({ name: 'example.bhpack', mimeType: 'application/zip', buffer: examplePack() });
  await expect(page.getByTestId('pack-row')).toContainText('Example pack');
  await expect(page.getByTestId('pack-row')).toContainText('2 patches');

  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByTestId('pack-row')).toContainText('Example pack');
  await page.getByRole('button', { name: 'Settings' }).click();

  await page.getByTestId('apk-input').setInputFiles({ name: 'synthetic.apk', mimeType: 'application/vnd.android.package-archive', buffer: Buffer.from(buildSyntheticApk()) });
  await expect(page.getByRole('heading', { name: 'Review the fixes' })).toBeVisible();
  const asset = page.locator('label', { hasText: 'Add a hello file' });
  await expect(asset).toContainText('Pack');
  await expect(asset.getByRole('checkbox')).not.toBeChecked();
  await asset.getByRole('checkbox').check();
  await page.getByRole('button', { name: /^Patch game \(\d+ fix(es)?\)$/ }).click();
  await expect(page.getByRole('heading', { name: 'Your game is fixed!' })).toBeVisible({ timeout: 60_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save patched APK' }).click()]);
  const files = unzipSync(new Uint8Array(readFileSync((await download.path())!)));
  expect(new TextDecoder().decode(files['assets/patch-pack-example.txt'])).toBe('Hello from the example patch pack.\n');

  // removing the pack takes its patches away
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Remove Example pack' }).click();
  await expect(page.getByText('No packs imported.')).toBeVisible();
});
