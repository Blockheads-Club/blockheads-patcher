import { beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '$lib/i18n';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { apkFile, mockEngine, mockPlatform } from '$lib/testing';
import { PatcherState } from '$lib/state.svelte';
import App from './App.svelte';

beforeEach(() => setLanguage('en'));

test('Cancel button aborts the running patch and returns to the review step', async () => {
  const engine = mockEngine({
    reload: vi.fn(async (a) => a) as never,
    patchLoaded: vi.fn((_a, opts) => new Promise((_res, rej) => {
      const cancel = () => rej(Object.assign(new Error('cancelled'), { name: 'CancelledError' }));
      if (opts.signal!.aborted) cancel(); // the click may land before the engine started
      else opts.signal!.addEventListener('abort', cancel);
    })) as never
  });
  render(App, { state: new PatcherState(mockPlatform(), engine) });
  await fireEvent.change(screen.getByTestId('apk-input'), { target: { files: [apkFile()] } });
  await fireEvent.click(await screen.findByRole('button', { name: 'Patch and sign' }, { timeout: 5000 }));
  await fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }, { timeout: 5000 }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Patch and sign' })).toBeInTheDocument(), { timeout: 5000 });
  expect(screen.queryByRole('alert')).toBeNull();
});
