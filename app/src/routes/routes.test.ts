import { expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { mockEngine, mockPlatform } from '$lib/testing';

vi.mock('$lib/engine', async (orig) => ({ ...(await orig<object>()), createEngine: () => mockEngine() }));
vi.mock('$lib/platform', () => ({ getPlatform: () => mockPlatform() }));

import { ssr, prerender } from './+layout';
import Page from './+page.svelte';
import Layout from './+layout.svelte';
import { createRawSnippet, tick } from 'svelte';
import { setLanguage, t } from '$lib/i18n';
import { get } from 'svelte/store';

test('layout flags', () => { expect(ssr).toBe(false); expect(prerender).toBe(false); });

test('page renders the app once the boot work is done', async () => {
  localStorage.setItem('bhp.consent', '1');
  render(Page);
  expect(document.title).toBeTruthy();
  expect((await screen.findAllByRole('heading')).length).toBeGreaterThan(0);
});

test('layout renders children, sprite, sets lang and applies the saved theme', () => {
  localStorage.setItem('bhp.theme', 'dark');
  render(Layout, { children: createRawSnippet(() => ({ render: () => '<p>kid</p>' })) });
  expect(screen.getByText('kid')).toBeInTheDocument();
  expect(document.documentElement.lang).toBe('en');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.getElementById('i-key')).toBeTruthy();
  localStorage.removeItem('bhp.theme');
  document.documentElement.removeAttribute('data-theme');
});

test('page title follows the language', async () => {
  render(Page);
  await screen.findAllByRole('heading');
  const title = () => get(t)('app.title');
  expect(document.title).toBe(title());
  setLanguage('tr');
  await tick();
  expect(document.title).toBe(title());
  setLanguage('en');
  await tick();
  expect(document.title).toBe(title());
});
