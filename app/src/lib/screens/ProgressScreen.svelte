<script lang="ts">
  import logo from '$lib/assets/patcher-icon.svg';
  import { t, lang } from '$lib/i18n';
  import { completedRows, overallPercent, ROWS } from '$lib/progress';
  import { formatClock, numberLocale } from '$lib/format';
  import { copyText } from '$lib/clipboard';
  import type { PatcherState } from '$lib/state.svelte';
  import type { KeysState } from '$lib/keys.svelte';
  import type { Prefs } from '$lib/prefs.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import ProgressBar from '$lib/ui/ProgressBar.svelte';
  import { shortFingerprint } from '$lib/format';

  let { state: s, keys, prefs }: { state: PatcherState; keys: KeysState; prefs: Prefs } = $props();

  const done = $derived(completedRows(s.progress.stage, s.progress.fraction));
  const pct = $derived(overallPercent(s.progress.stage, s.progress.fraction));
  const fmt = (n: number) => new Intl.NumberFormat(numberLocale($lang), { style: 'percent' }).format(n / 100);
  const active = $derived(Math.min(done, ROWS.length - 1));
  const activeLabel = $derived($t(`stage.${ROWS[active]!}`));
  const names = $derived(s.selected.map((id) => $t(`patch.${id}.name`)).join(', '));
  const sub = $derived({
    read: $t('stage.readSub', { version: s.loaded?.info.versionName ?? '?' }),
    patch: names,
    write: $t('stage.writeSub'),
    sign: keys.active ? `${keys.active.name || $t('keys.defaultName')} · ${shortFingerprint(keys.active.fingerprint, 2, 1)}` : $t('review.newKeyHint')
  });
  const announce = $derived($t('progress.announce', { stage: activeLabel, pct: fmt(Math.floor(pct / 10) * 10) }));
  const logText = $derived(s.log.map((l) => `${formatClock(l.time)}  ${l.kind.padEnd(7)}${l.text}`).join('\n'));

  let copied = $state(false);
  async function copyLog() {
    copied = await copyText(logText);
    if (copied) setTimeout(() => (copied = false), 2000);
  }
</script>

<div class="top">
  <img src={logo} alt="" width="72" height="72" />
  <div class="tt"><h1>{$t('progress.title')}</h1><p class="muted">{$t('progress.lead')}</p></div>
</div>

<Card class="prog">
  <div class="ph">
    <p class="pl">{$t('progress.step', { label: activeLabel, n: active + 1 })}</p>
    <p class="mono pp">{fmt(pct)}</p>
  </div>
  <ProgressBar value={pct} label={$t('progress.aria')} valuetext={`${fmt(pct)}, ${activeLabel}`} striped />
</Card>

<Card tag="ol" class="stages" aria-label={$t('progress.stages')}>
  {#each ROWS as row, i (row)}
    <li class="stage" aria-current={i === active && done < ROWS.length ? 'step' : undefined}>
      <span class={['si', { ok: i < done, on: i === active && done < ROWS.length }]}>
        {#if i < done}<Icon name="check" />{:else if i === active}<span class="spin" aria-hidden="true"></span>{:else}<Icon name="dot" />{/if}
      </span>
      <div class="sx"><p class={['sn', { dim: i > done }]}>{$t(`stage.${row}`)}</p><p class="hint">{sub[row]}</p></div>
      <span class={['hint', 'ss', { act: i === active && i >= done }]}>{i < done ? $t('stage.done') : i === active ? $t('stage.active') : $t('stage.waiting')}</span>
    </li>
  {/each}
</Card>

{#if prefs.showLog}
  <details class="lg" open>
    <summary><Icon name="chev-d" class="chev" />{$t('log.title')}<span class="hint">{$t('log.for')}</span></summary>
    <pre class="log" role="log" aria-label={$t('log.aria')}>{logText}</pre>
    <div class="lr"><Button size="sm" icon={copied ? 'check' : 'copy'} onclick={copyLog}>{copied ? $t('action.copied') : $t('log.copy')}</Button></div>
  </details>
{/if}

<div class="bottom">
  <p class="sr-only" role="status" aria-live="polite">{announce}</p>
  <span></span>
  <Button icon="x" onclick={() => s.cancel()}>{$t('action.cancel')}</Button>
</div>

<style>
  .top { display: flex; align-items: center; gap: 18px; }
  .top img { border-radius: 16px; transform: rotate(-6deg); box-shadow: 0 4px 0 var(--logo-edge); flex: none; }
  .tt { display: flex; flex-direction: column; gap: 4px; }
  h1 { font-size: 32px; }
  :global(.prog) { display: flex; flex-direction: column; gap: 12px; --card-pad: 22px; }
  .ph { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .pl { font-weight: 700; font-size: 17px; }
  .pp { font-size: 16px; font-weight: 600; }
  :global(.stages) { list-style: none; margin: 0; --card-pad: 4px 0; }
  .stage { display: flex; gap: 14px; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--line); }
  .stage:last-child { border-bottom: 0; }
  .si { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; flex: none; background: var(--surface-2); color: var(--text-3); }
  .si.ok { background: var(--ok-soft); color: var(--ok); }
  .si.on { background: var(--primary-soft); }
  .sx { flex: 1; min-width: 0; }
  .sn { font-weight: 700; }
  .sn.dim { color: var(--text-2); }
  .sx .hint { overflow-wrap: anywhere; }
  .ss { text-align: end; }
  .act { color: var(--primary-ink); font-weight: 700; }
  .spin { width: 20px; height: 20px; border-radius: 50%; border: 3px solid var(--surface-3); border-top-color: var(--primary); animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .lg { background: var(--surface); border: 2px solid var(--line); border-radius: var(--r-lg); padding: 4px 18px 16px; }
  .lg summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; font-weight: 700; min-height: 44px; }
  .lg summary::-webkit-details-marker { display: none; }
  .lg summary .hint { font-weight: 400; margin-inline-start: auto; }
  .lg[open] summary :global(.chev) { transform: rotate(180deg); }
  .log { background: var(--code-bg); color: var(--code-text); font: 13px/1.75 var(--f-mono); padding: 14px 16px; border-radius: 12px; max-height: 200px; overflow: auto; white-space: pre-wrap; margin: 0; overflow-wrap: anywhere; }
  .lr { display: flex; justify-content: flex-end; margin-top: 10px; }
  .bottom { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  @media (max-width: 600px) { .top { flex-direction: column; text-align: center; } h1 { font-size: 26px; } .top img { width: 96px; height: 96px; } .ss { display: none; } }
</style>
