<script lang="ts">
  import { lang, t } from '$lib/i18n';
  import { formatBytes } from '$lib/format';
  import type { UpdateInfo, UpdateState } from '$lib/update.svelte';
  import logo from '$lib/assets/patcher-icon-macos.svg';
  import Badge from '$lib/ui/Badge.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import ProgressBar from '$lib/ui/ProgressBar.svelte';

  /** `busy`: a patch is running, so the web app must not reload now. */
  let { update: u, busy = false }: { update: UpdateState; busy?: boolean } = $props();

  const stage = $derived(u.stage === 'idle' ? 'checking' : u.stage);
  /** Read only in the stages that have one (`available`, also after the hand-off). */
  const info = $derived(u.info as UpdateInfo);
  const v = $derived(info.version);
  const android = $derived(u.kind === 'tauri-android');
  /** Native build without a matching file (Linux .deb/.rpm): the release page instead of a download. */
  const pageOnly = $derived(!u.web && !info.download);
  const handoff = $derived(stage === 'available' && u.handedOff);

  const badge = $derived(
    stage === 'checking' ? $t('upd.badge.checking') : stage === 'uptodate' ? $t('upd.badge.uptodate')
    : stage === 'error' ? $t('upd.badge.error') : handoff ? $t('upd.badge.handoff') : $t('upd.badge.available')
  );
  const tone = $derived(stage === 'error' ? 'bad' : stage === 'uptodate' || handoff ? 'ok' : 'primary');
  const title = $derived(
    stage === 'checking' ? $t('upd.t.checking') : stage === 'uptodate' ? $t('upd.t.uptodate')
    : stage === 'error' ? $t('upd.t.error') : handoff ? $t('upd.t.handoff') : $t('upd.t.available', { v })
  );
  const body = $derived.by(() => {
    if (stage === 'checking') return $t('upd.b.checking');
    if (stage === 'uptodate') return $t('upd.b.uptodate');
    if (stage === 'error') return $t('upd.b.error');
    if (handoff) {
      if (pageOnly) return $t('upd.b.handoffPage');
      const file = info.download!.name;
      return android ? $t('upd.b.handoffAndroid', { file }) : $t('upd.b.handoffDesktop', { file, v });
    }
    if (u.web) return $t('upd.b.availableWeb');
    return $t(pageOnly ? 'upd.b.availablePage' : android ? 'upd.b.availableAndroid' : 'upd.b.availableDesktop', { current: u.current });
  });
  const sizeLine = $derived(u.web ? $t('upd.noDownload') : info.download ? $t('upd.size', { size: formatBytes(info.download.size, $lang) }) : '');
  const closable = $derived(stage !== 'checking');
  const close = () => u.hide();
</script>

<Dialog labelledby="upd-t" describedby="upd-d" onclose={closable ? close : () => u.cancel()}>
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
      <div class="box bad" role="alert"><Icon name="alert" /><span><strong>{$t('upd.failed')}</strong> {$t('upd.failedHint')}</span></div>
    {:else if handoff}
      <div class="box ok" role="status"><Icon name="check" /><span>{$t('upd.kept')}</span></div>
    {:else}
      {#if info.notes.length}
        <ul class="notes" aria-label={$t('upd.notes')}>{#each info.notes as n, i (i)}<li>{n}</li>{/each}</ul>
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
  .link { border: 0; padding: 0; background: none; font: inherit; color: var(--primary-ink); text-decoration: underline; cursor: pointer; }
  .link:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
  .df { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; padding: 16px 24px 22px; }
</style>
