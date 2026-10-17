<script lang="ts">
  import { t } from '$lib/i18n';
  import { describeError } from '$lib/errors';
  import type { PatchApkResult } from '$lib/engine';
  import type { PlatformAdapter } from '$lib/platform/types';

  let { platform, result, onreset }: { platform: PlatformAdapter; result: PatchApkResult; onreset?: () => void } = $props();

  let note = $state<string | null>(null);
  let error = $state<string | null>(null);
  let installAllowed = $state<boolean | undefined>(undefined);

  let installing = $state(false);

  // The user may grant "install unknown apps" in system settings and come back: re-check on focus/visibility.
  $effect(() => {
    if (!platform.canRequestInstalls) return;
    const check = () => { platform.canRequestInstalls!().then((a) => (installAllowed = a), () => (installAllowed = undefined)); };
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  });

  const names = $derived(result.applied.map((id) => $t(`patch.${id}.name`)).join(', '));

  async function guard(fn: () => Promise<void>) {
    error = null; note = null;
    try { await fn(); } catch (e) { error = describeError($t, e); }
  }
  const save = () => guard(async () => {
    const r = await platform.saveOutput(result.suggestedFileName, result.bytes);
    note = r.location ? $t('result.saved', { location: r.location }) : $t('result.savedGeneric');
  });
  const uninstall = () => guard(async () => {
    const r = await platform.uninstallOriginal!();
    note = r.completed === false ? $t('result.uninstallCancelled') : r.completed === true ? $t('result.uninstalled') : $t('result.started');
  });
  const install = () => guard(async () => {
    installing = true;
    try {
      const r = await platform.installApk!(result.suggestedFileName, result.bytes);
      note = r.status === 'success' ? $t('result.installed') : r.status === 'pending' ? $t('result.installPending') : $t('result.started');
    } finally { installing = false; }
  });
  const openSettings = () => guard(async () => { await platform.openInstallSettings!(); });
</script>

<section aria-labelledby="result-title">
  <h2 id="result-title">{$t('result.title')}</h2>
  <p>{$t('result.file', { name: result.suggestedFileName })}</p>
  {#if result.applied.length}<p>{$t('result.applied', { list: names })}</p>{/if}
  {#if result.skipped.length}<p class="muted">{$t('result.skipped', { list: result.skipped.map((s) => $t(`patch.${s.id}.name`)).join(', ') })}</p>{/if}
  <p class="muted"><span>{$t('result.cert')}</span>: <code class="fp">{result.certSha256}</code></p>

  <div class="warn" role="note" data-testid="signature-warning">{$t('result.signatureWarning')}</div>

  <div class="row">
    {#if platform.uninstallOriginal}
      <button type="button" onclick={uninstall}>{$t('result.uninstall')}</button>
    {/if}
    <button type="button" class="primary" onclick={save}>{$t('result.save')}</button>
    {#if platform.installApk}
      <button type="button" class="primary" onclick={install} disabled={installAllowed === false || installing}>{$t('result.install')}</button>
    {/if}
  </div>

  {#if installAllowed === false}
    <p class="error" role="alert">{$t('result.installBlocked')}</p>
    {#if platform.openInstallSettings}<button type="button" onclick={openSettings}>{$t('result.openSettings')}</button>{/if}
  {/if}
  {#if note}<p role="status" class="ok">{note}</p>{/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}

  <h3>{$t('result.stepsTitle')}</h3>
  <ol>
    <li>{$t('result.step1')}</li>
    <li>{$t('result.step2')}</li>
    <li>{$t('result.step3')}</li>
  </ol>
  {#if onreset}<button type="button" onclick={onreset}>{$t('action.startOver')}</button>{/if}
</section>

<style>
  .fp { word-break: break-all; font-size: 0.8rem; }
  .row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.75rem 0; }
  .warn { border: 1px solid var(--warn-border); background: var(--warn-bg); border-radius: 10px; padding: 0.75rem 1rem; margin: 0.75rem 0; }
</style>
