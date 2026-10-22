<script lang="ts" module>
  export type View = 'patch' | 'keys' | 'settings';
</script>

<script lang="ts">
  import logo from '$lib/assets/patcher-icon.svg';
  import { t } from '$lib/i18n';
  import Button from './Button.svelte';
  import Stepper from './Stepper.svelte';
  import UpdateButton from './UpdateButton.svelte';
  import type { UpdateState } from '$lib/update.svelte';

  let { view, step, failed = false, install = false, locked = false, update, onnavigate }: {
    view: View; step: number; failed?: boolean; install?: boolean; locked?: boolean; update?: UpdateState; onnavigate: (v: View) => void;
  } = $props();
</script>

<header class="appbar">
  <div class="brand">
    <img src={logo} alt="" width="38" height="38" />
    <span class="name"><small>{$t('brand.club')}</small><b>{$t('brand.product')}</b></span>
  </div>
  {#if view === 'patch'}<Stepper current={step} {failed} {install} />{/if}
  <div class="end">
  {#if update}<UpdateButton {update} />{/if}
  {#if locked}
    <span class="hint locked" role="status">{$t('nav.locked')}</span>
  {:else}
    <nav class="tools" aria-label={$t('app.title')}>
      <Button variant="ghost" size="sm" icon="patch" current={view === 'patch'} class="tool" onclick={() => onnavigate('patch')}>{$t('nav.patcher')}</Button>
      <Button variant="ghost" size="sm" icon="key" current={view === 'keys'} class="tool" onclick={() => onnavigate(view === 'keys' ? 'patch' : 'keys')}>{$t('nav.keys')}</Button>
      <Button variant="ghost" size="sm" icon="sliders" current={view === 'settings'} class="tool" onclick={() => onnavigate(view === 'settings' ? 'patch' : 'settings')}>{$t('nav.settings')}</Button>
    </nav>
  {/if}
  </div>
</header>

<style>
  .appbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: max(12px, env(safe-area-inset-top)) 20px 12px; border-bottom: 2px solid var(--line); background: var(--surface); flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand img { border-radius: 9px; }
  .name { display: flex; flex-direction: column; line-height: 1.1; }
  small { font: 700 12px var(--f-body); color: var(--text-3); }
  b { font: 800 19px var(--f-display); letter-spacing: -0.01em; }
  .tools { display: flex; gap: 6px; }
  .end { display: flex; gap: 6px; align-items: center; }
  /* Brand and the Patcher / Keys / Settings tabs share the top row; the stepper sits between them when there is
     room, else on its own row below (never pushing the tabs down). */
  .brand { order: 1; }
  .end { order: 2; }
  .appbar > :global(.stepper) { order: 3; flex-basis: 100%; display: flex; justify-content: center; }
  @media (min-width: 1100px) {
    .appbar > :global(.stepper) { order: 2; flex-basis: auto; }
    .end { order: 3; }
  }
  .locked { min-width: 120px; text-align: end; }
  @media (max-width: 600px) {
    .appbar { padding-inline: 12px; gap: 8px 6px; }
    .brand { flex: 1; }
    .tools :global(.tool) { width: 48px; padding: 0; }
    .tools :global(.tool .label) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .locked { flex: 0 1 auto; }
  }
</style>
