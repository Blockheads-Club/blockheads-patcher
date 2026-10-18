import { expect, test } from '@playwright/test';

test('the start-up card is in the initial HTML, so it paints before any script runs', async ({ request }) => {
  const html = await (await request.get('/')).text();
  const body = html.slice(html.indexOf('<body'));
  expect(body).toContain('id="boot-splash"');
  expect(body).toContain('Blockheads');
  expect(body).toContain('Loading fixes and your signing key');
  expect(body).toMatch(/<b>\d+\.\d+\.\d+/);
  // The card comes before the app mount point.
  expect(body.indexOf('boot-splash')).toBeLessThan(body.indexOf('display: contents'));
});

test('with JavaScript disabled the card is visible', async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.locator('#boot-splash')).toBeVisible();
  await expect(page.locator('.bs-card .bs-bar')).toBeVisible();
  await ctx.close();
});

test('the card hands over to the app and is gone afterwards', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('dialog', { name: 'Before you start' })).toBeVisible();
  await expect(page.locator('#boot-splash')).toHaveCount(0);
});

test('Turkish browsers get the Turkish card', async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, locale: 'tr-TR' });
  const page = await ctx.newPage();
  await page.goto('/');
  // Without JS the language switch (a script) does not run, so English stays; with JS on, the card switches before paint.
  await expect(page.locator('.bs-en').first()).toBeVisible();
  await ctx.close();
  const js = await browser.newContext({ locale: 'tr-TR' });
  const p2 = await js.newPage();
  await p2.route('**/_app/**', (r) => r.abort());
  await p2.goto('/');
  await expect(p2.locator('.bs-tr').first()).toBeVisible();
  await expect(p2.locator('.bs-en').first()).toBeHidden();
  await js.close();
});
