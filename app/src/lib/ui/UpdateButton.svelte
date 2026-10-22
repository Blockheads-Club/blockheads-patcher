<script lang="ts">
  import { t } from '$lib/i18n';
  import type { UpdateState } from '$lib/update.svelte';
  import Icon from './Icon.svelte';

  /** The always-visible update icon of the app bar. Its dot shows the state; colour is never the only signal. */
  let { update: u }: { update: UpdateState } = $props();

  const st = $derived(u.stage === 'error' ? 'failed' : u.stage === 'idle' || u.stage === 'uptodate' ? 'idle' : u.stage);
  const n = $derived(u.percent);
  const label = $derived.by(() => {
    switch (st) {
      case 'checking': return $t('upd.checking');
      case 'available': return $t('upd.pill');
      case 'downloading': return $t('upd.pill.downloading', { n });
      case 'installing': return $t('upd.pill.installing');
      case 'ready': return $t('upd.pill.ready');
      default: return $t('upd.check');
    }
  });
  const aria = $derived.by(() => {
    switch (st) {
      case 'available': return $t('upd.aria.available', { v: u.info!.version });
      case 'downloading': return $t('upd.aria.downloading', { n });
      case 'installing': return $t('upd.aria.installing');
      case 'ready': return $t('upd.aria.ready');
      case 'failed': return $t('upd.aria.failed');
      default: return label;
    }
  });
</script>

<button class={['upd', st]} aria-label={aria} title={aria} aria-haspopup="dialog" aria-busy={st === 'checking' || st === 'installing' || undefined} onclick={() => u.show()}>
  {#if st === 'checking' || st === 'installing'}<span class="spin" aria-hidden="true"></span>{:else}<Icon name="update" size={18} />{/if}
  <span class="label">{label}</span>
  {#if st === 'available' || st === 'failed' || st === 'ready'}<span class="pip" aria-hidden="true"></span>{/if}
  {#if st === 'downloading'}<span class="ring" style:--p={`${n}%`} aria-hidden="true"></span>{/if}
</button>

<style>
  .upd {
    position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 0 12px;
    border-radius: var(--r-md); border: 2px solid var(--line-strong); background: var(--surface); color: var(--text);
    font: 700 14px/1.2 var(--f-body); box-shadow: var(--edge); cursor: pointer; white-space: nowrap;
    transition: transform var(--dur-press), box-shadow var(--dur-press), background-color var(--dur-fast);
  }
  .upd:hover { background: var(--surface-2); }
  .upd:active { transform: translateY(2px); box-shadow: 0 1px 0 var(--line-strong); }
  .upd.available, .upd.downloading { background: var(--primary-soft); border-color: var(--primary); color: var(--primary-ink); }
  .upd.ready { background: var(--ok-soft); border-color: var(--ok); color: var(--ok); }
  .upd.checking, .upd.installing { cursor: progress; }
  .pip { position: absolute; top: 5px; left: 22px; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--surface); background: var(--primary); }
  .failed .pip { background: var(--bad); }
  .ready .pip { background: var(--ok); }
  /* Downloading: a ring around the arrow fills with the progress. */
  .ring {
    position: absolute; left: 7px; top: 50%; width: 26px; height: 26px; margin-top: -13px; border-radius: 50%;
    background: conic-gradient(var(--primary) 0 var(--p), var(--surface-3) 0);
    -webkit-mask: radial-gradient(closest-side, transparent calc(100% - 3px), #000 calc(100% - 2px));
    mask: radial-gradient(closest-side, transparent calc(100% - 3px), #000 calc(100% - 2px));
  }
  .spin { width: 18px; height: 18px; border-radius: 50%; border: 3px solid var(--surface-3); border-top-color: var(--primary); animation: spin 0.9s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
  /* Narrow windows: the icon without the label (the label stays the accessible name). */
  @media (max-width: 600px) {
    .upd { width: 48px; padding: 0; }
    .ring { left: 9px; }
    .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  }
</style>
