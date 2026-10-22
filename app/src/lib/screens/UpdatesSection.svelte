<script lang="ts">
  import { lang, t } from '$lib/i18n';
  import { formatDate } from '$lib/format';
  import type { Channel, UpdateState } from '$lib/update.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import Segmented from '$lib/ui/Segmented.svelte';
  import Switch from '$lib/ui/Switch.svelte';

  /** Settings → Updates: the same check as the update icon, plus the automatic options. */
  let { update: u, now = () => Date.now() }: { update: UpdateState; now?: () => number } = $props();

  const stage = $derived(u.stage);
  const result = $derived.by(() => {
    switch (stage) {
      case 'checking': return $t('upd.s.checking');
      case 'available': return $t('upd.s.available', { v: u.info!.version });
      case 'downloading': return $t('upd.s.downloading', { v: u.info!.version });
      case 'installing': return $t('upd.s.installing');
      case 'ready': return $t('upd.s.ready', { v: u.info!.version });
      case 'error': return $t('upd.s.failed');
      case 'uptodate': return $t('upd.s.ok');
      default: return $t('upd.s.idle');
    }
  });
  /** Something to show in the popup: the button opens it instead of checking again. */
  const found = $derived(['available', 'downloading', 'installing', 'ready'].includes(stage));
  const icon = $derived(found ? 'update' : stage === 'error' ? 'alert' : stage === 'uptodate' ? 'check' : '');
  function when(ms: number): string {
    if (!ms) return $t('upd.s.never');
    if (now() - ms < 60_000) return $t('upd.s.justNow');
    const time = new Intl.DateTimeFormat($lang, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
    return `${formatDate(ms, $lang)} ${time}`;
  }
  const last = $derived(stage === 'error' ? $t('upd.s.lastOk', { when: when(u.lastSuccess) }) : $t('upd.s.last', { when: when(u.lastChecked) }));
  const channel = $derived(u.channel);
</script>

<Card tag="section" class="grp" aria-labelledby="s-u">
  <h2 id="s-u">{$t('settings.updates')}</h2>
  <div class="row">
    <div class="rl">
      <p class="rt">{$t('upd.s.version', { v: u.current })}</p>
      <p class={['res', stage]} role="status">
        {#if stage === 'checking' || stage === 'installing'}<span class="spin" aria-hidden="true"></span>{:else if icon}<Icon name={icon} size={18} />{/if}{result}
      </p>
      <p class="hint">{last}</p>
    </div>
    {#if found}
      <Button size="sm" variant="primary" icon="update" onclick={() => u.show()}>{$t('upd.s.show')}</Button>
    {:else}
      <Button size="sm" icon="refresh" disabled={stage === 'checking'} onclick={() => void u.check()}>{stage === 'error' ? $t('upd.s.retry') : $t('upd.s.checkNow')}</Button>
    {/if}
  </div>
  <div class="row">
    <Switch id="sw-upd" bind:checked={() => u.autoCheck, (v) => u.setAutoCheck(v)} label={$t('upd.s.auto')} hint={u.web ? $t('upd.s.autoHintWeb') : $t('upd.s.autoHint')} />
  </div>
  {#if !u.web}
    <div class="row">
      <div class="rl"><p class="rt" id="s-ch">{$t('upd.s.channel')}</p><p class="hint">{$t('upd.s.channelHint')}</p></div>
      <Segmented bind:value={() => channel, (c) => u.setChannel(c as Channel)} labelledby="s-ch" options={[
        { value: 'stable', label: $t('upd.s.stable') },
        { value: 'beta', label: $t('upd.s.beta') }
      ]} />
    </div>
  {/if}
</Card>

<style>
  :global(.grp) h2 { font-size: 19px; padding: 16px 0 6px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 0; border-top: 1px solid var(--line); flex-wrap: wrap; }
  h2 + .row { border-top: 0; }
  .rl { flex: 1 1 260px; min-width: 0; }
  .rt { font-weight: 700; }
  .res { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14.5px; margin: 2px 0; color: var(--text-2); }
  .res.uptodate { color: var(--ok); }
  .res.available, .res.downloading { color: var(--primary-ink); }
  .res.ready { color: var(--ok); }
  .res.error { color: var(--bad); }
  .spin { width: 18px; height: 18px; border-radius: 50%; border: 3px solid var(--surface-3); border-top-color: var(--primary); animation: spin 0.9s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
