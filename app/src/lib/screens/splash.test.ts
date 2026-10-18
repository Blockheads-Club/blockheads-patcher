import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { setLanguage } from '$lib/i18n';
import SplashScreen from './SplashScreen.svelte';

afterEach(() => { cleanup(); setLanguage('en'); });
const noop = () => {};

test('loading and slow states show the progress bar, the message and the footer with the version', () => {
  const { rerender } = render(SplashScreen, { phase: 'loading', version: '1.2.3', onretry: noop });
  const card = screen.getByRole('status', { name: 'Blockheads Patcher is starting' });
  expect(card).toBeVisible();
  expect(screen.getByText('Loading fixes and your signing key…')).toBeVisible();
  expect(screen.getByText('A Blockheads Club project · unofficial')).toBeVisible();
  expect(screen.getByText('1.2.3')).toBeVisible();
  expect(card.querySelector('.bar')).not.toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  void rerender({ phase: 'slow', version: '1.2.3', onretry: noop });
});

test('slow message, and no version in the footer when there is none', async () => {
  render(SplashScreen, { phase: 'slow', onretry: noop });
  expect(screen.getByText(/Still working/)).toBeVisible();
  expect(document.querySelector('.foot .mono')).toBeNull();
});

test('error state offers Try again, Open log and Quit, each wired', async () => {
  const [retry, log, quit] = [vi.fn(), vi.fn(), vi.fn()];
  render(SplashScreen, { phase: 'error', version: '1', onretry: retry, onopenlog: log, onquit: quit });
  expect(screen.getByRole('alert')).toHaveTextContent('Your files are safe');
  await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Open log' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Quit' }));
  expect([retry, log, quit].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
});

test('error state without log and quit shows only Try again, and the technical detail when given', () => {
  render(SplashScreen, { phase: 'error', detail: 'boom', onretry: noop });
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Try again']);
  expect(screen.getByText('boom')).toBeVisible();
});

test('windowed card is draggable and square on request', () => {
  render(SplashScreen, { phase: 'loading', version: '1', windowed: true, square: true, onretry: noop });
  const card = screen.getByRole('status');
  expect(card).toHaveAttribute('data-tauri-drag-region');
  expect(card).toHaveClass('windowed', 'square');
  cleanup();
  render(SplashScreen, { phase: 'loading', onretry: noop });
  expect(screen.getByRole('status')).not.toHaveAttribute('data-tauri-drag-region');
});

test('text follows the language', () => {
  setLanguage('tr');
  render(SplashScreen, { phase: 'loading', onretry: noop });
  expect(screen.getByRole('status', { name: 'Blockheads Patcher başlıyor' })).toBeVisible();
});

test('phone layout: icon on the disc, wordmark, spoken status; error with Try again only', async () => {
  const retry = vi.fn();
  const { rerender } = render(SplashScreen, { phase: 'loading', variant: 'phone', onretry: retry });
  expect(screen.getByRole('status')).toBeVisible();
  expect(screen.getByText('Loading fixes and your signing key…')).toHaveClass('sr-only');
  expect(screen.queryByRole('alert')).toBeNull();
  await rerender({ phase: 'slow', variant: 'phone', onretry: retry });
  expect(screen.getByText(/Still working/)).toHaveClass('sr-only');
  await rerender({ phase: 'error', variant: 'phone', onretry: retry });
  expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load the list of fixes.');
  await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(retry).toHaveBeenCalled();
});
