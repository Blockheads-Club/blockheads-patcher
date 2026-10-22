import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bhp.consent', '1'));
});

test('the build serves its version; the update icon checks against it', async ({ page, request }) => {
  const res = await request.get('./version.json');
  expect(res.ok()).toBe(true);
  const { version } = (await res.json()) as { version: string };
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
  await page.goto('./');
  await page.getByRole('button', { name: 'Check for updates' }).click();
  const dialog = page.getByRole('dialog', { name: 'The Patcher is up to date' });
  await expect(dialog).toContainText(`You have the newest version, ${version}.`);
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toHaveCount(0);
});

test('a newer deployment: the popup opens by itself once, Reload now reloads the page', async ({ page }) => {
  await page.route('**/version.json?*', (route) => route.fulfill({ contentType: 'application/json', body: '{"version":"99.0.0"}' }));
  await page.goto('./');
  const dialog = page.getByRole('dialog', { name: 'Patcher 99.0.0 is here' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveTitle('↑ Blockheads Patcher');
  await dialog.getByRole('button', { name: 'Later' }).click();
  await page.getByRole('button', { name: 'Update available: 99.0.0' }).click();
  const reloaded = page.waitForEvent('load');
  await dialog.getByRole('button', { name: 'Reload now' }).click();
  await reloaded;
  // Already shown for this version: after the reload it does not pop up again, the icon keeps the dot.
  await expect(page.getByRole('button', { name: 'Update available: 99.0.0' })).toBeVisible();
  await expect(dialog).toHaveCount(0);
});
