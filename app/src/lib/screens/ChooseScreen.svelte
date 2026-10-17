<script lang="ts">
  import { t } from '$lib/i18n';
  import { describeError, describeReason } from '$lib/errors';
  import { GUIDES_URL } from '$lib/links';
  import { fileToPicked } from '$lib/platform/web';
  import type { InstalledGameInfo } from '$lib/platform/types';
  import type { PatcherState } from '$lib/state.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Callout from '$lib/ui/Callout.svelte';
  import Card from '$lib/ui/Card.svelte';
  import DropZone from '$lib/ui/DropZone.svelte';
  import Icon from '$lib/ui/Icon.svelte';

  let { state: s }: { state: PatcherState } = $props();
  const platform = $derived(s.platform);

  let input: HTMLInputElement | undefined = $state();
  let readFile = $state<{ name: string; size: number } | null>(null);
  let readSeq = 0;
  let local = $state<{ name?: string; text: string } | null>(null);
  let installed = $state<InstalledGameInfo | null | undefined>(undefined);

  $effect(() => {
    if (platform.getInstalledGame) platform.getInstalledGame().then((g) => (installed = g), () => (installed = null));
  });

  const split = $derived(!!installed && installed.splitSourceDirs.length > 0);
  const reading = $derived(s.loading ? s.pending : readFile);
  const mode = $derived(reading ? 'reading' : local || s.error || s.unsupported ? 'error' : 'idle');

  const err = $derived.by(() => {
    const u = s.unsupported;
    if (local) return { title: local.name ? $t('drop.errReadTitle', { name: local.name }) : $t('drop.errOpenTitle'), body: local.text };
    if (u?.wrongPackage) return { title: $t('drop.errWrongTitle'), body: $t('drop.errWrongBody', { name: u.name, pkg: u.packageName }) };
    if (u) {
      const reason = u.reason ? describeReason($t, u.reason) : '';
      return { title: $t('drop.errVersionTitle', { version: u.versionName ?? '?' }), body: $t('drop.errVersionBody', { name: u.name, reason }).trim(), helpLabel: $t('drop.versions') };
    }
    return s.error ? { title: $t('drop.errReadTitle', { name: s.lastName ?? '' }), body: describeError($t, s.error) } : null;
  });

  async function fromFile(f: File) {
    local = null;
    const seq = ++readSeq;
    readFile = { name: f.name, size: f.size };
    try {
      const p = await fileToPicked(f);
      if (seq !== readSeq) return;
      readFile = null;
      void s.load(p);
    } catch (e) {
      if (seq === readSeq) { readFile = null; local = { name: f.name, text: describeError($t, e) }; }
    }
  }
  async function browse() {
    local = null;
    if (platform.kind === 'web') { input?.click(); return; }
    try {
      const p = await platform.pickApk();
      if (p) void s.load(p);
    } catch (e) { local = { text: describeError($t, e) }; }
  }
  async function useInstalled() {
    local = null;
    try { void s.load(await platform.loadInstalledApk!()); }
    catch (e) { local = { text: describeError($t, e) }; }
  }
  function cancel() {
    readSeq++;
    readFile = null;
    s.cancelLoad();
  }
</script>

{#snippet installedCard()}
  <Card selected class="installed">
    <div class="ih">
      <span class="ii"><Icon name="phone" size={24} /></span>
      <div>
        <p class="it">{installed ? $t('installed.found') : $t('installed.missing')}</p>
        {#if installed}<p class="muted">The Blockheads {#if installed.versionName}<span class="mono">{installed.versionName}</span>{/if}</p>{/if}
      </div>
    </div>
    {#if split}<Callout tone="warn" role="alert">{$t('picker.splitInstalled')}</Callout>{/if}
    {#if installed}<Button variant="primary" onclick={useInstalled} disabled={split || !!reading}>{$t('installed.use')}</Button>{/if}
  </Card>
{/snippet}

<div class="head">
  <h1>{$t('choose.title')}</h1>
  <p class="muted lead">{$t('choose.lead')}</p>
</div>

<input bind:this={input} type="file" accept=".apk,application/vnd.android.package-archive" hidden data-testid="apk-input"
  onchange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void fromFile(f); }} />

{#if platform.getInstalledGame && mode === 'idle'}
  {#if installed !== undefined}{@render installedCard()}{/if}
  {#if installed}<div class="or"><span></span>{$t('drop.or')}<span></span></div>{/if}
  <Button icon="folder" onclick={browse} disabled={!!reading}>{$t('installed.pick')}</Button>
{:else}
  <DropZone {mode} droppable={platform.kind === 'web'} file={reading} error={err} onbrowse={browse} oncancel={cancel} onfile={fromFile} />
  {#if platform.getInstalledGame && installed}{@render installedCard()}{/if}
{/if}

<div class="info">
  <Callout tone="info" title={$t('choose.private.title')}>{$t('choose.private.body')}</Callout>
  <a class="first" href={GUIDES_URL} target="_blank" rel="noopener noreferrer">
    <Icon name="book" class="fi" />
    <span><span class="ft">{$t('choose.first.title')}</span><span class="fb">{$t('choose.first.body')}</span></span>
  </a>
</div>

<style>
  .head { display: flex; flex-direction: column; gap: 8px; }
  h1 { font-size: 34px; }
  .lead { font-size: 17px; }
  :global(.installed) { display: flex; flex-direction: column; gap: 14px; --card-pad: 18px; }
  .ih { display: flex; gap: 12px; align-items: center; }
  .ii { width: 48px; height: 48px; border-radius: 13px; background: var(--sun); color: var(--on-sun); display: grid; place-items: center; transform: rotate(-6deg); box-shadow: 0 3px 0 var(--sun-edge); flex: none; }
  .it { font-weight: 700; }
  .or { display: flex; align-items: center; gap: 12px; color: var(--text-3); font-size: 14px; }
  .or span { flex: 1; height: 2px; background: var(--line); }
  .info { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 14px; }
  .first { display: flex; gap: 14px; align-items: flex-start; padding: 14px 16px; background: var(--surface); border: 2px solid var(--line); border-radius: 12px; text-decoration: none; color: var(--text); }
  .first:hover { background: var(--surface-2); color: var(--text); }
  .first :global(.fi) { color: var(--primary-ink); margin-top: 2px; }
  .ft { display: block; font-weight: 700; }
  .fb { display: block; font-size: 14.5px; color: var(--text-2); }
</style>
