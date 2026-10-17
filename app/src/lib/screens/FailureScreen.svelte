<script lang="ts">
  import { t } from '$lib/i18n';
  import { describeError } from '$lib/errors';
  import { formatClock } from '$lib/format';
  import { copyText } from '$lib/clipboard';
  import { ISSUES_URL } from '$lib/links';
  import type { PatcherState } from '$lib/state.svelte';
  import Blob from '$lib/ui/Blob.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Icon from '$lib/ui/Icon.svelte';

  let { state: s, onopenkeys }: { state: PatcherState; onopenkeys: () => void } = $props();

  const message = $derived(describeError($t, s.error));
  const logText = $derived(s.log.map((l) => `${formatClock(l.time)}  ${l.kind.padEnd(7)}${l.text}`).join('\n'));
  let copied = $state(false);
  async function copyLog() {
    copied = await copyText(logText);
    if (copied) setTimeout(() => (copied = false), 2000);
  }
</script>

<div class="hero" role="alert">
  <Blob icon="alert" tone="bad" size={96} />
  <div class="ht"><h1>{$t('result.failTitle')}</h1><p class="muted">{$t('result.failLead')}</p><p class="muted msg">{message}</p></div>
</div>

<Card class="what">
  <p class="wt">{$t('result.failWhat')}</p>
  <ul><li>{$t('result.failTip1')}</li><li>{$t('result.failTip2')}</li><li>{$t('result.failTip3')}</li></ul>
  <div class="row">
    <Button variant="primary" icon="refresh" onclick={() => s.run()}>{$t('result.tryAgain')}</Button>
    <Button icon="key" onclick={onopenkeys}>{$t('result.openKeys')}</Button>
  </div>
</Card>

<details class="det" open>
  <summary><Icon name="chev-d" class="chev" />{$t('result.showDetails')}</summary>
  <pre class="log" role="log" aria-label={$t('log.aria')}>{logText}</pre>
  <div class="dr">
    <Button size="sm" icon={copied ? 'check' : 'copy'} onclick={copyLog}>{copied ? $t('action.copied') : $t('log.copy')}</Button>
    <Button size="sm" icon="code" href={ISSUES_URL} external>{$t('result.report')}</Button>
  </div>
</details>

<Button variant="ghost" class="again" onclick={() => s.reset()}>{$t('action.startOver')}</Button>

<style>
  .hero { display: flex; gap: 22px; align-items: center; flex-wrap: wrap; }
  .ht { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 260px; }
  h1 { font-size: 34px; }
  .ht p { font-size: 17px; }
  .msg { overflow-wrap: anywhere; }
  :global(.what) { display: flex; flex-direction: column; gap: 12px; --card-pad: 20px 22px; }
  .wt { font-weight: 700; }
  ul { margin: 0; padding-inline-start: 20px; display: flex; flex-direction: column; gap: 6px; color: var(--text-2); }
  .row, .dr { display: flex; gap: 10px; flex-wrap: wrap; }
  .dr { justify-content: flex-end; margin-top: 10px; }
  .det { background: var(--surface); border: 2px solid var(--line); border-radius: var(--r-lg); padding: 6px 20px 16px; }
  .det summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; font-weight: 700; min-height: 44px; }
  .det summary::-webkit-details-marker { display: none; }
  .det[open] summary :global(.chev) { transform: rotate(180deg); }
  .log { background: var(--code-bg); color: var(--code-text); font: 13px/1.75 var(--f-mono); padding: 14px 16px; border-radius: 12px; white-space: pre-wrap; margin: 0; overflow: auto; overflow-wrap: anywhere; }
  :global(.again) { align-self: flex-start; }
</style>
