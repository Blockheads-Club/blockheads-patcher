<script lang="ts">
  import { t, lang } from '$lib/i18n';
  import { GUIDES_URL } from '$lib/links';
  import { formatBytes } from '$lib/format';
  import Blob from './Blob.svelte';
  import Button from './Button.svelte';
  import Card from './Card.svelte';
  import Icon from './Icon.svelte';
  import ProgressBar from './ProgressBar.svelte';

  type Err = { title: string; body: string; helpLabel?: string };
  let { mode, droppable = false, file = null, error = null, onbrowse, oncancel, onfile }: {
    mode: 'idle' | 'reading' | 'error'; droppable?: boolean; file?: { name: string; size: number } | null; error?: Err | null;
    onbrowse: () => void; oncancel: () => void; onfile: (f: File) => void;
  } = $props();

  let over = $state(false);
  const showOver = $derived(droppable && over && mode !== 'reading');

  function ondrop(e: DragEvent) {
    e.preventDefault();
    over = false;
    const f = e.dataTransfer?.files?.[0];
    if (f && mode !== 'reading') onfile(f);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class={['drop', { over: showOver, err: mode === 'error' && !showOver, reading: mode === 'reading' }]} aria-label={$t('drop.aria')}
  aria-busy={mode === 'reading'} role={mode === 'error' && !showOver ? 'alert' : undefined}
  ondragover={(e) => { e.preventDefault(); over = true; }} ondragleave={() => (over = false)} {ondrop}>
  {#if showOver}
    <div class="over-in" aria-live="polite">
      <Blob icon="download" tone="primary" />
      <h2 class="over-t">{$t('drop.over')}</h2>
      <p class="muted">{$t('drop.overHint')}</p>
    </div>
  {:else if mode === 'reading' && file}
    <Card class="reading-card">
      <div class="file">
        <span class="fi"><Icon name="file" /></span>
        <div class="meta"><p class="fname">{file.name}</p><p class="hint">{formatBytes(file.size, $lang)}</p></div>
        <Button variant="ghost" size="sm" iconOnly icon="x" onclick={oncancel}>{$t('drop.cancelRead')}</Button>
      </div>
      <ProgressBar value={null} label={$t('drop.readingBar')} />
      <p class="status" role="status"><span class="spin" aria-hidden="true"></span>{$t('drop.reading')}</p>
    </Card>
  {:else if mode === 'error' && error}
    <Blob icon="alert" tone="bad" />
    <h2>{error.title}</h2>
    <p class="muted body">{error.body}</p>
    <div class="actions">
      <Button variant="primary" icon="folder" onclick={onbrowse}>{$t('drop.another')}</Button>
      {#if error.helpLabel}<Button variant="ghost" href={GUIDES_URL} external>{error.helpLabel}</Button>{/if}
    </div>
  {:else}
    <Blob icon="upload" tone="sun" />
    <h2>{droppable ? $t('drop.title') : $t('drop.titleBrowse')}</h2>
    {#if droppable}<p class="muted">{$t('drop.or')}</p>{/if}
    <Button variant="primary" size="lg" icon="folder" onclick={onbrowse}>{$t('drop.browse')}</Button>
    <p class="hint">{$t('drop.hint')} · <a href={GUIDES_URL} target="_blank" rel="noopener noreferrer">{$t('drop.howTo')}</a></p>
  {/if}
</div>

<style>
  .drop { border: 3px dashed var(--line-strong); border-radius: var(--r-xl); background: var(--surface); min-height: 340px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 36px 24px; text-align: center; transition: background-color var(--dur-fast), border-color var(--dur-fast); }
  .drop.over { border-style: solid; border-color: var(--primary); background: var(--primary-soft); }
  .drop.err { border-style: solid; border-color: var(--bad); }
  .drop.reading { border-style: solid; }
  h2 { font-size: 24px; }
  .over-in { display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .over-t { color: var(--primary-ink); }
  .body { max-width: 520px; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
  .drop :global(.reading-card) { width: 100%; max-width: 520px; display: flex; flex-direction: column; gap: 14px; text-align: start; --card-pad: 18px 20px; }
  .file { display: flex; gap: 14px; align-items: center; }
  .fi { width: 44px; height: 44px; border-radius: 12px; background: var(--surface-2); display: grid; place-items: center; flex: none; }
  .meta { flex: 1; min-width: 0; }
  .fname { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { display: flex; gap: 10px; align-items: center; font-weight: 700; }
  .spin { width: 22px; height: 22px; border-radius: 50%; border: 3px solid var(--surface-3); border-top-color: var(--primary); animation: spin 0.9s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
