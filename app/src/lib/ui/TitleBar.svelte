<script lang="ts">
  import { onMount } from 'svelte';
  import logo from '$lib/assets/patcher-icon-small.svg';
  import { t } from '$lib/i18n';
  import { win, type Os } from '$lib/winctl';
  import type { UpdateState } from '$lib/update.svelte';
  import Icon from './Icon.svelte';

  let { os, ctx = '', maximized, update }: {
    os: Os;
    /** The part after "Blockheads Patcher ·". */
    ctx?: string;
    /** Force the maximized look; otherwise tracked from the window. */
    maximized?: boolean;
    /** Update state: while the popup is hidden, a chip after the title shows it and opens the popup again. */
    update?: UpdateState;
  } = $props();

  let isMax = $state(false);
  let inactive = $state(false);
  const max = $derived(maximized ?? isMax);
  /** macOS draws the traffic lights itself (overlay title bar): leave room for them. */
  const native = $derived(os === 'macos');

  onMount(() => {
    const sync = () => void win.isMaximized().then((m) => (isMax = m)).catch(() => {});
    sync();
    const offs: (() => void)[] = [];
    let gone = false;
    const keep = (p: Promise<() => void>) => p.then((u) => (gone ? u() : offs.push(u))).catch(() => {});
    void keep(win.onResized(sync));
    void keep(win.onFocus((f) => (inactive = !f)));
    return () => { gone = true; offs.forEach((u) => u()); };
  });

  const minimize = () => void win.minimize().catch(() => {});
  const toggle = () => void win.toggleMaximize().catch(() => {});
  const close = () => void win.close().catch(() => {});
  const maxLabel = $derived(max ? $t('tb.restore') : $t('tb.maximize'));
  const chip = $derived(
    !update || update.open ? '' : update.stage === 'available' ? $t('upd.chip.available') : update.stage === 'error' ? $t('upd.chip.failed') : ''
  );
</script>

<header class={['bar', os, inactive && 'inactive']} aria-label={$t('tb.label')} data-tauri-drag-region>
  {#if native}<div class="native" aria-hidden="true" data-tauri-drag-region></div>{/if}
  <div class="title" data-tauri-drag-region>
    <img src={logo} alt="" width="20" height="20" data-tauri-drag-region />
    <span class="name" data-tauri-drag-region>Blockheads<span class="tag" data-tauri-drag-region>{$t('brand.product')}</span></span>
    {#if ctx}<span class="ctx" data-tauri-drag-region>{`· ${ctx}`}</span>{/if}
    {#if chip}
      <button class={['chip', update!.stage]} aria-haspopup="dialog" aria-label={$t('upd.chip.aria', { state: chip })} onclick={() => update!.show()}>
        <Icon name="update" size={16} />{chip}
      </button>
    {/if}
  </div>
  {#if os === 'windows'}
    <div class="wctl" role="group" aria-label={$t('tb.controls')}>
      <button class="w" aria-label={$t('tb.minimize')} onclick={minimize}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" stroke-width="1.2" /></svg>
      </button>
      <button class="w" aria-label={maxLabel} onclick={toggle}>
        {#if max}
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x=".6" y="2.6" width="6.8" height="6.8" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" /><path d="M2.6 2.6V1.6A1 1 0 0 1 3.6.6h4.8a1 1 0 0 1 1 1v4.8a1 1 0 0 1-1 1h-1" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
        {:else}
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x=".6" y=".6" width="8.8" height="8.8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
        {/if}
      </button>
      <button class="w close" aria-label={$t('tb.close')} onclick={close}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M.8.8l8.4 8.4M9.2.8L.8 9.2" stroke="currentColor" stroke-width="1.2" /></svg>
      </button>
    </div>
  {:else if os === 'linux'}
    <div class="lctl" role="group" aria-label={$t('tb.controls')}>
      <button class="l" aria-label={$t('tb.minimize')} onclick={minimize}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 7h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
      <button class="l" aria-label={maxLabel} onclick={toggle}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.3" y="1.3" width="7.4" height="7.4" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
      </button>
      <button class="l close" aria-label={$t('tb.close')} onclick={close}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
    </div>
  {/if}
</header>

<style>
  .bar {
    --b-bg: var(--surface-2); --b-line: var(--line); --b-fg: var(--text); --b-fg2: var(--text-3);
    --b-hov: rgba(31, 26, 23, 0.08); --b-round: var(--surface-3); --b-round-hov: #dcd2c6;
    flex: none; width: 100%; height: var(--titlebar-h, 40px); display: flex; align-items: center;
    background: var(--b-bg); border-bottom: 1px solid var(--b-line); color: var(--b-fg);
    user-select: none; -webkit-user-select: none;
  }
  :global(:root[data-theme='dark']) .bar { --b-bg: #1d1815; --b-line: #3a312b; --b-fg: #f5ede5; --b-fg2: #ae9f92; --b-hov: rgba(255,255,255,.12); --b-round: #312924; --b-round-hov: #4a413c; }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme='light']):not([data-theme='dark'])) .bar { --b-bg: #1d1815; --b-line: #3a312b; --b-fg: #f5ede5; --b-fg2: #ae9f92; --b-hov: rgba(255,255,255,.12); --b-round: #312924; --b-round-hov: #4a413c; }
  }
  .bar.inactive { --b-fg: var(--b-fg2); }
  .title { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding-left: 12px; height: 100%; }
  .macos .title { justify-content: center; padding-right: 72px; }
  .title img { flex: none; pointer-events: none; border-radius: 5px; }
  .inactive .title img { opacity: 0.55; }
  .name { display: inline-flex; align-items: center; gap: 6px; font: 800 14px/1 var(--f-display); letter-spacing: -0.01em; white-space: nowrap; color: var(--b-fg); }
  .tag { display: inline-block; padding: 2px 6px 3px; border-radius: 5px; transform: rotate(-3deg); font-size: 12.5px; background: var(--sun); color: var(--on-sun); box-shadow: 0 2px 0 var(--sun-edge); pointer-events: none; }
  .inactive .tag { opacity: 0.6; }
  .ctx { font: 400 13px/1 var(--f-body); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--b-fg2); }
  button { border: 0; margin: 0; padding: 0; display: grid; place-items: center; cursor: default; font: inherit; color: var(--b-fg); background: transparent; }
  button:focus-visible { outline: 3px solid var(--focus); outline-offset: -3px; }
  .wctl { display: flex; height: 100%; flex: none; }
  .w { width: 46px; height: 100%; }
  .w:hover { background: var(--b-hov); }
  .w.close:hover { background: #c8301e; color: #fff; }
  .lctl { display: flex; gap: 10px; align-items: center; padding: 0 10px; flex: none; }
  .l { width: 28px; height: 28px; border-radius: 50%; background: var(--b-round); }
  .l:hover { background: var(--b-round-hov); }
  .l.close:hover { background: #c8301e; color: #fff; }
  .native { width: 78px; height: 100%; flex: none; }
  .chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; flex: none; border-radius: 999px; border: 1.5px solid currentColor; font: 700 12.5px var(--f-body); white-space: nowrap; cursor: pointer; color: var(--primary-ink); }
  .chip.error { color: var(--bad); }
  .chip:hover { background: var(--b-hov); }
  .chip:focus-visible { outline-offset: 2px; }
</style>
