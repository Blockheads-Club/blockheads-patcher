<script lang="ts">
  import { lang, t } from '$lib/i18n';
  import { formatBytes } from '$lib/format';
  import type { DownloadProgress, UpdateInfo, UpdateState } from '$lib/update.svelte';
  import logo from '$lib/assets/patcher-icon-macos.svg';
  import Badge from '$lib/ui/Badge.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import ProgressBar from '$lib/ui/ProgressBar.svelte';

  /** `busy`: a patch is running, so the app must not reload or restart now. */
  let { update: u, busy = false }: { update: UpdateState; busy?: boolean } = $props();

  const stage = $derived(u.stage === 'idle' ? 'checking' : u.stage);
  /** Read only in the stages that have one (from `available` on, also after the hand-off). */
  const info = $derived(u.info as UpdateInfo);
  const v = $derived(info.version);
  const android = $derived(u.kind === 'tauri-android');
  /** Native build without a matching file (Linux .deb/.rpm): the release page instead of a download. */
  const pageOnly = $derived(!u.web && !info.download);
  const handoff = $derived(stage === 'available' && u.handedOff);
  const p = $derived(u.progress as DownloadProgress);
  const n = $derived(u.percent);

  const badge = $derived(
    stage === 'checking' ? $t('upd.badge.checking') : stage === 'uptodate' ? $t('upd.badge.uptodate')
    : stage === 'error' ? $t('upd.badge.error') : stage === 'downloading' || stage === 'installing' ? $t('upd.badge.updating')
    : stage === 'ready' ? $t('upd.badge.ready') : handoff ? $t('upd.badge.handoff') : $t('upd.badge.available')
  );
  const tone = $derived(stage === 'error' ? 'bad' : stage === 'uptodate' || stage === 'ready' || handoff ? 'ok' : 'primary');
  const title = $derived.by(() => {
    switch (stage) {
      case 'checking': return $t('upd.t.checking');
      case 'uptodate': return $t('upd.t.uptodate');
      case 'error': return u.installFailed ? $t('upd.t.installFailed') : $t('upd.t.error');
      case 'downloading': return $t('upd.t.downloading', { v });
      case 'installing': return $t('upd.t.installing', { v });
      case 'ready': return $t('upd.t.ready');
      default: return handoff ? $t('upd.t.handoff') : $t('upd.t.available', { v });
    }
  });
  const body = $derived.by(() => {
    switch (stage) {
      case 'checking': return $t('upd.b.checking');
      case 'uptodate': return $t('upd.b.uptodate');
      case 'error': return u.installFailed ? $t('upd.b.installFailed') : $t('upd.b.error');
      case 'downloading': return $t('upd.b.downloading');
      case 'installing': return $t('upd.b.installing');
      case 'ready': return $t('upd.b.ready');
    }
    if (handoff) {
      if (pageOnly) return $t('upd.b.handoffPage');
      const file = info.download!.name;
      return android ? $t('upd.b.handoffAndroid', { file }) : $t('upd.b.handoffDesktop', { file, v });
    }
    if (u.web) return $t('upd.b.availableWeb');
    const key = info.inPlace ? 'upd.b.availableInPlace' : pageOnly ? 'upd.b.availablePage' : android ? 'upd.b.availableAndroid' : 'upd.b.availableDesktop';
    return $t(key, { current: u.current });
  });
  const sizeLine = $derived(u.web ? $t('upd.noDownload') : info.download ? $t('upd.size', { size: formatBytes(info.download.size, $lang) }) : '');
  const stats = $derived.by(() => {
    const done = formatBytes(p.done, $lang), speed = formatBytes(p.speed, $lang);
    const line = p.total === null ? $t('upd.dlStatsNoTotal', { done, speed }) : $t('upd.dlStats', { done, total: formatBytes(p.total, $lang), speed });
    return p.eta === null ? line : line + $t('upd.dlEta', { s: p.eta });
  });
  const closable = $derived(stage !== 'checking' && stage !== 'installing');
  const close = () => u.hide();
  const onclose = $derived(closable ? close : stage === 'checking' ? () => u.cancel() : undefined);
</script>

<Dialog labelledby="upd-t" describedby="upd-d" {onclose}>
  <div class="dh">
    <img src={logo} alt="" width="60" height="60" />
    <div class="ht">
      <Badge {tone}>{badge}</Badge>
      <h2 id="upd-t">{title}</h2>
    </div>
    {#if closable}<Button variant="ghost" icon="x" iconOnly class="x" onclick={close}>{$t('upd.close')}</Button>{/if}
  </div>
  <div class="db">
    <p id="upd-d" class="muted lead">{body}</p>
    {#if stage === 'checking'}
      <ProgressBar value={null} label={$t('upd.progress')} />
      <p class="hint" role="status">{$t('upd.looking')}</p>
    {:else if stage === 'uptodate'}
      <div class="box ok" role="status"><Icon name="check" /><span>{$t('upd.newest', { v: u.current })}</span></div>
    {:else if stage === 'error'}
      <div class="box bad" role="alert"><Icon name="alert" /><span>
        {#if u.installFailed}<strong>{u.error}</strong> {$t('upd.installError')}{:else}<strong>{$t('upd.failed')}</strong> {$t('upd.failedHint')}{/if}
      </span></div>
    {:else if stage === 'downloading'}
      <div class="line"><strong>{$t('upd.dl')}</strong><span class="mono">{`${n} %`}</span></div>
      <ProgressBar value={n} label={$t('upd.dlProgress')}
        valuetext={p.eta === null ? $t('upd.dlTextNoEta', { n }) : $t('upd.dlText', { n, s: p.eta })} />
      <p class="hint mono stats">{stats}</p>
      <p class="hint">{$t('upd.keepWorking')}</p>
    {:else if stage === 'installing'}
      <ProgressBar value={null} label={$t('upd.installingStep')} />
      <div class="stp"><span class="si ok"><Icon name="check" size={16} /></span>{$t('upd.verified')}</div>
      <div class="stp"><span class="si cur"><span class="spin" aria-hidden="true"></span></span><strong>{$t('upd.installingStep')}</strong></div>
      <div class="stp dim"><span class="si"><Icon name="dot" size={16} /></span>{$t('upd.restartStep')}</div>
    {:else if stage === 'ready'}
      {#if busy}
        <div class="box warn" role="status"><Icon name="alert" /><span>{$t('upd.busyRestart')}</span></div>
      {:else}
        <div class="box ok" role="status"><Icon name="check" /><span>{$t('upd.readyLine')}</span></div>
      {/if}
    {:else if handoff}
      <div class="box ok" role="status"><Icon name="check" /><span>{$t('upd.kept')}</span></div>
    {:else}
      {#if info.notes.length}
        <ul class="notes" aria-label={$t('upd.notes')}>{#each info.notes as note, i (i)}<li>{note}</li>{/each}</ul>
      {/if}
      {#if u.web && busy}
        <div class="box warn" role="status"><Icon name="alert" /><span>{$t('upd.busy')}</span></div>
      {:else}
        <div class="box info"><Icon name="shield" /><span>{$t('upd.kept')}</span></div>
      {/if}
      <p class="hint">{#if sizeLine}{`${sizeLine} · `}{/if}<button class="link" onclick={() => u.openPage()}>{$t('upd.fullNotes')}</button></p>
    {/if}
  </div>
  <div class="df">
    {#if stage === 'checking'}
      <Button variant="ghost" onclick={() => u.cancel()}>{$t('upd.cancel')}</Button>
    {:else if stage === 'uptodate'}
      <Button variant="primary" onclick={close}>{$t('upd.ok')}</Button>
    {:else if stage === 'error'}
      <Button variant="ghost" icon="globe" onclick={() => u.openPage()}>{$t('upd.website')}</Button>
      <Button variant="primary" icon="refresh" onclick={() => void u.check({ popup: true })}>{$t('upd.retry')}</Button>
    {:else if stage === 'downloading'}
      <Button variant="ghost" onclick={close}>{$t('upd.hide')}</Button>
      <Button onclick={() => u.cancelDownload()}>{$t('upd.cancelDl')}</Button>
    {:else if stage === 'installing'}
      <Button disabled>{$t('upd.restartNow')}</Button>
    {:else if stage === 'ready'}
      <Button variant="ghost" onclick={close}>{$t('upd.later')}</Button>
      <Button variant="primary" icon="refresh" disabled={busy} onclick={() => void u.restart()}>{$t('upd.restartNow')}</Button>
    {:else if handoff}
      <Button variant="ghost" icon="globe" onclick={() => u.openPage()}>{$t('upd.openPage')}</Button>
      <Button variant="primary" onclick={close}>{$t('upd.ok')}</Button>
    {:else}
      <Button variant="ghost" onclick={close}>{$t('upd.later')}</Button>
      {#if u.web}
        <Button variant="primary" icon="refresh" disabled={busy} onclick={() => void u.install()}>{$t('upd.reload')}</Button>
      {:else}
        <Button variant="primary" icon={pageOnly ? 'globe' : 'download'} onclick={() => void u.install()}>{pageOnly ? $t('upd.openPage') : $t('upd.install')}</Button>
      {/if}
    {/if}
  </div>
</Dialog>

<style>
  .dh { display: flex; gap: 16px; align-items: center; padding: 22px 24px 10px; }
  .dh img { border-radius: 15px; flex: none; }
  .ht { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
  h2 { font-size: 23px; }
  .dh :global(.x) { align-self: flex-start; }
  .db { padding: 6px 24px 4px; display: flex; flex-direction: column; gap: 12px; }
  .lead { font-size: 15.5px; }
  .notes { margin: 0; padding: 12px 14px 12px 32px; border-radius: 12px; background: var(--surface-2); display: flex; flex-direction: column; gap: 6px; font-size: 14.5px; }
  .box { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 12px; font-size: 14.5px; }
  .box :global(.ico) { margin-top: 2px; }
  .box.ok { background: var(--ok-soft); } .box.ok :global(.ico) { color: var(--ok); }
  .box.info { background: var(--info-soft); } .box.info :global(.ico) { color: var(--info); }
  .box.warn { background: var(--warn-soft); } .box.warn :global(.ico) { color: var(--warn); }
  .box.bad { background: var(--bad-soft); } .box.bad :global(.ico) { color: var(--bad); }
  .line { display: flex; justify-content: space-between; gap: 12px; font-size: 14.5px; }
  .mono { font-family: var(--f-mono); font-weight: 600; }
  .stats { font-size: 12.5px; font-weight: 400; }
  .stp { display: flex; gap: 10px; align-items: center; font-size: 14.5px; }
  .stp.dim { color: var(--text-3); }
  .si { width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; flex: none; background: var(--surface-2); }
  .si.ok { background: var(--ok-soft); color: var(--ok); }
  .si.cur { background: var(--primary-soft); }
  .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--surface-3); border-top-color: var(--primary); animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
  .link { border: 0; padding: 0; background: none; font: inherit; color: var(--primary-ink); text-decoration: underline; cursor: pointer; }
  .link:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
  .df { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; padding: 16px 24px 22px; }
</style>
