<script lang="ts">
  import { t } from '$lib/i18n';
  import type { PickedApk, PlatformAdapter, InstalledGameInfo } from '$lib/platform/types';
  import { describeError } from '$lib/errors';
  import { fileToPicked } from '$lib/platform/web';

  let { platform, onpicked, busy = false }: { platform: PlatformAdapter; onpicked: (p: PickedApk) => void; busy?: boolean } = $props();

  let dragging = $state(false);
  let message = $state<string | null>(null);
  let reading = $state(false);
  let installed = $state<InstalledGameInfo | null | undefined>(undefined);
  let input: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (platform.getInstalledGame) platform.getInstalledGame().then((g) => (installed = g), () => (installed = null));
  });

  const isBusy = $derived(busy || reading);
  const split = $derived(!!installed && installed.splitSourceDirs.length > 0);

  async function fromFile(f: File | undefined) {
    if (!f || isBusy) return;
    message = null;
    reading = true;
    try {
      const p = await fileToPicked(f);
      reading = false;
      onpicked(p);
    } catch (e) {
      message = describeError($t, e);
    } finally {
      reading = false;
    }
  }
  async function choose() {
    message = null;
    if (platform.kind === 'web') { input?.click(); return; }
    try {
      const p = await platform.pickApk();
      if (p) onpicked(p);
    } catch (e) { message = describeError($t, e); }
  }
  async function useInstalled() {
    message = null;
    try { onpicked(await platform.loadInstalledApk!()); }
    catch (e) { message = describeError($t, e); }
  }
  function ondrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    fromFile(e.dataTransfer?.files?.[0]);
  }
</script>

<section class="picker" aria-labelledby="picker-title">
  <h2 id="picker-title">{$t('picker.title')}</h2>
  <p class="muted">{$t('picker.hint')}</p>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="drop" class:dragging ondragover={(e) => { e.preventDefault(); dragging = true; }} ondragleave={() => (dragging = false)} {ondrop}>
    <button type="button" class="primary" onclick={choose} disabled={isBusy}>{$t('picker.choose')}</button>
    {#if platform.kind === 'web'}<span class="muted">{$t('picker.drop')}</span>{/if}
    <input bind:this={input} type="file" accept=".apk,application/vnd.android.package-archive" hidden data-testid="apk-input"
      onchange={(e) => { fromFile(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
  </div>

  {#if platform.getInstalledGame}
    <div class="installed">
      <button type="button" onclick={useInstalled} disabled={isBusy || !installed || split}>{$t('picker.useInstalled')}</button>
      {#if installed}
        <span class="muted">{`${installed.packageName}${installed.versionName ? ` ${installed.versionName}` : ''}`}</span>
        {#if split}<span class="error" role="alert">{$t('picker.splitInstalled')}</span>{/if}
      {:else if installed === null}
        <span class="muted">{$t('picker.installedMissing')}</span>
      {/if}
    </div>
  {/if}

  {#if reading}<p role="status">{$t('picker.reading')}</p>{:else if busy}<p role="status">{$t('picker.loading')}</p>{/if}
  {#if message}<p role="alert" class="error">{message}</p>{/if}
</section>

<style>
  .drop { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; padding: 1.25rem; border: 2px dashed var(--border); border-radius: 12px; }
  .drop.dragging { border-color: var(--accent); background: var(--accent-bg); }
  .installed { margin-top: 0.75rem; display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
</style>
