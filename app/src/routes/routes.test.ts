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

test('page renders the app', () => {
  render(Page);
  expect(document.title).toBeTruthy();
  expect(screen.getAllByRole('heading').length).toBeGreaterThan(0);
});

test('layout renders children and sets lang', () => {
  render(Layout, { children: createRawSnippet(() => ({ render: () => '<p>kid</p>' })) });
  expect(screen.getByText('kid')).toBeInTheDocument();
  expect(document.documentElement.lang).toBe('en');
});

test('page title follows the language', async () => {
  render(Page);
  const title = () => get(t)('app.title');
  expect(document.title).toBe(title());
  setLanguage('tr');
  await tick();
  expect(document.title).toBe(title());
  setLanguage('en');
  await tick();
  expect(document.title).toBe(title());
});
