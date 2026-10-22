import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { setLanguage } from '$lib/i18n';
import { mockEngine, mockPlatform } from '$lib/testing';
import { PatcherState } from '$lib/state.svelte';
import { KeysState, MemoryKeyLibrary } from '$lib/keys.svelte';
import { Prefs, giveConsent } from '$lib/prefs.svelte';
import { UpdateState } from '$lib/update.svelte';
import App from './App.svelte';

beforeEach(() => { setLanguage('en'); localStorage.clear(); });

function mount({ consent = true, patching = false, auto = true } = {}) {
  if (consent) giveConsent();
  if (!auto) localStorage.setItem('bhp.upd.auto', '0');
  const engine = mockEngine();
  const state = new PatcherState(mockPlatform(), engine);
  if (patching) state.stage = 'patching';
  const update = new UpdateState({ kind: 'web', current: '0.1.1', fetch: vi.fn(async () => new Response('{"version":"0.2.0"}')) as never, openUrl: async () => {}, reload: vi.fn() });
  const view = render(App, { state, keys: new KeysState(engine, new MemoryKeyLibrary()), prefs: new Prefs(), update });
  return { update, state, ...view };
}
const under = (c: HTMLElement) => (c.querySelector('.under') as HTMLElement & { inert: boolean }).inert;

describe('updates in the app', () => {
  test('the automatic check opens the popup once; the app behind is inert; Later keeps the icon dot', async () => {
    const { update, container } = mount();
    expect(await screen.findByRole('dialog', { name: 'Patcher 0.2.0 is here' })).toBeInTheDocument();
    expect(under(container)).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(under(container)).toBe(false);
    expect(update.pending).toBe(false);
    expect(screen.getByRole('button', { name: 'Update available: 0.2.0' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('heading', { name: 'Updates' })).toBeInTheDocument();
  });
  test('waits for consent and for the patch to finish', async () => {
    const { update } = mount({ consent: false });
    await vi.waitFor(() => expect(update.pending).toBe(true));
    expect(screen.queryByRole('dialog', { name: /is here/ })).toBeNull();
    const busy = mount({ patching: true });
    await vi.waitFor(() => expect(busy.update.pending).toBe(true));
    expect(screen.queryByRole('dialog', { name: /is here/ })).toBeNull();
  });
  test('automatic check off: the icon starts a check on demand', async () => {
    const { update } = mount({ auto: false });
    expect(update.stage).toBe('idle');
    await fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByRole('dialog', { name: 'Patcher 0.2.0 is here' })).toBeInTheDocument();
  });
});
