<script lang="ts">
  import { t } from '$lib/i18n';
  import { describeError } from '$lib/errors';
  import { GUIDES_URL } from '$lib/links';
  import type { PatchApkResult } from '$lib/engine';
  import type { PlatformAdapter } from '$lib/platform/types';
  import Blob from '$lib/ui/Blob.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Callout from '$lib/ui/Callout.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Icon from '$lib/ui/Icon.svelte';

  /** Android: uninstall the original (signature differs), then install the fixed game. */
  let { platform, result, onreset, onopenkeys }: { platform: PlatformAdapter; result: PatchApkResult; onreset: () => void; onopenkeys: () => void } = $props();

  let backedUp = $state(false);
  let originalGone = $state(false);
  let originalMissing = $state(false);
  let installing = $state(false);
  let installed = $state(false);
  let installAllowed = $state<boolean | undefined>(undefined);
  let note = $state<string | null>(null);
  let error = $state<string | null>(null);

  // Was the original even installed? If not there is nothing to uninstall.
  $effect(() => {
    platform.getInstalledGame?.().then((g) => { if (!g) originalMissing = true; }, () => {});
  });

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

  const step1Done = $derived(originalGone || originalMissing);

  async function guard(fn: () => Promise<void>) {
    error = null; note = null;
    try { await fn(); } catch (e) { error = describeError($t, e); }
  }
  const uninstall = () => guard(async () => {
    const r = await platform.uninstallOriginal!();
    if (r.completed === false) note = $t('result.uninstallCancelled');
    else { originalGone = true; note = r.completed === true ? $t('result.uninstalled') : $t('result.started'); }
  });
  const install = () => guard(async () => {
    installing = true;
    try {
      const r = await platform.installApk!(result.suggestedFileName, result.bytes);
      if (r.status === 'success') installed = true;
      else note = r.status === 'pending' ? $t('result.installPending') : $t('result.started');
    } finally { installing = false; }
  });
  const saveCopy = () => guard(async () => {
    const r = await platform.saveOutput(result.suggestedFileName, result.bytes);
    note = r.location ? $t('result.saved', { location: r.location }) : $t('result.savedGeneric');
  });
</script>

{#if installed}
  <div class="done" role="status">
    <Blob icon="check" tone="ok" size={112} />
    <h1>{$t('done.title')}</h1>
    <p class="muted">{$t('done.lead')}</p>
    <div class="sun">
      <Icon name="key" />
      <p><strong>{$t('done.key')}</strong> {$t('done.keyBody')} <a href="#keys" onclick={(e) => { e.preventDefault(); onopenkeys(); }}>{$t('done.exportKey')}</a></p>
    </div>
    <Button icon="plus" onclick={onreset}>{$t('result.again')}</Button>
  </div>
{:else}
  <div class="head">
    <h1>{$t('swap.title')}</h1>
    <p class="muted">{$t('swap.lead')}</p>
  </div>

  {#if !step1Done}
    <Callout tone="warn" role="alert" title={$t('swap.warnTitle')}>
      {$t('swap.warnBody')}
      {#snippet actions()}<a class="how" href={GUIDES_URL} target="_blank" rel="noopener noreferrer"><Icon name="book" size={16} />{$t('swap.backup')}</a>{/snippet}
    </Callout>
    <label class="confirm"><input type="checkbox" class="chk" bind:checked={backedUp} />{$t('swap.confirm')}</label>
  {/if}

  {#if step1Done}
    <Card class="stepc"><div class="sh"><span class="num ok"><Icon name="check" size={18} /></span><div><p class="st">{originalMissing && !originalGone ? $t('swap.s1None') : $t('swap.s1Done')}</p></div></div></Card>
  {:else}
    <Card class="stepc">
      <div class="sh"><span class="num">1</span><p class="st">{$t('swap.s1')}</p></div>
      <Button variant="danger" icon="trash" onclick={uninstall} disabled={!backedUp}>{$t('swap.s1Button')}</Button>
    </Card>
  {/if}

  <Card class="stepc" selected={step1Done} muted={!step1Done}>
    <div class="sh"><span class={['num', { off: !step1Done }]}>2</span><p class={['st', { dim: !step1Done }]}>{$t('swap.s2')}</p></div>
    <Button variant={step1Done ? 'primary' : 'secondary'} icon="download" onclick={install} loading={installing}
      disabled={!step1Done || installAllowed === false} aria-describedby="s2-hint">{$t('swap.s2Button')}</Button>
    <p id="s2-hint" class="hint">{step1Done ? $t('swap.s2Hint') : $t('swap.s2Wait')}</p>
    {#if installAllowed === false}
      <Callout tone="bad" role="alert">
        {$t('result.installBlocked')}
        {#snippet actions()}{#if platform.openInstallSettings}<Button size="sm" onclick={() => guard(async () => { await platform.openInstallSettings!(); })}>{$t('result.openSettings')}</Button>{/if}{/snippet}
      </Callout>
    {/if}
  </Card>

  <Button variant="ghost" icon="download" onclick={saveCopy}>{$t('swap.saveCopy')}</Button>
  {#if note}<Callout tone="ok" role="status">{note}</Callout>{/if}
  {#if error}<Callout tone="bad" role="alert">{error}</Callout>{/if}
{/if}

<style>
  .head { display: flex; flex-direction: column; gap: 8px; }
  h1 { font-size: 30px; }
  .done { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 16px; padding: 24px 0; }
  .sun { display: flex; gap: 12px; align-items: flex-start; padding: 14px; border-radius: 14px; background: var(--sun); color: var(--on-sun); text-align: start; }
  .sun a { color: var(--on-sun); font-weight: 700; }
  .how { font-weight: 700; font-size: 14.5px; display: inline-flex; align-items: center; gap: 6px; min-height: 40px; }
  .confirm { display: flex; gap: 12px; align-items: flex-start; padding: 4px 2px; font-weight: 700; font-size: 15.5px; }
  .chk { width: 24px; height: 24px; accent-color: var(--primary); margin: 0; flex: none; }
  :global(.stepc) { display: flex; flex-direction: column; gap: 12px; --card-pad: 14px 16px; }
  .sh { display: flex; gap: 12px; align-items: center; }
  .st { font-weight: 700; }
  .st.dim { color: var(--text-2); }
  .num { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; background: var(--sun); color: var(--on-sun); font: 800 15px var(--f-display); transform: rotate(-6deg); box-shadow: 0 2px 0 var(--sun-edge); flex: none; }
  .num.off { background: var(--surface-3); color: var(--text-3); box-shadow: none; }
  .num.ok { background: var(--ok); color: #fff; transform: none; box-shadow: none; }
</style>
