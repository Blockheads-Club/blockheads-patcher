<script lang="ts">
  import { t } from '$lib/i18n';
  import Icon from './Icon.svelte';

  /** current: 1..4. failed marks the current step as failed. `install` renames the last step (Android installs instead of saving). On phones it collapses into 4 progress segments. */
  let { current, failed = false, install = false }: { current: number; failed?: boolean; install?: boolean } = $props();
  const keys = $derived(['step.choose', 'step.review', 'step.patch', install ? 'step.install' : 'step.save'] as const);
</script>

<nav aria-label={$t('steps.label')} class="stepper">
  <ol>
    {#each keys as key, i (key)}
      {@const n = i + 1}
      {#if i > 0}<li class="line" aria-hidden="true"></li>{/if}
      <li class={['step', { done: n < current, current: n === current, fail: failed && n === current }]} aria-current={n === current ? 'step' : undefined}>
        <span class="n" aria-hidden="true">
          {#if failed && n === current}<Icon name="x" size={16} />{:else if n < current}<Icon name="check" size={16} />{:else}{n}{/if}
        </span>
        <span class="name">{$t(key)}</span>
      </li>
    {/each}
  </ol>
</nav>

<style>
  ol { list-style: none; margin: 0; padding: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .step { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 14.5px; color: var(--text-3); }
  .n { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; border: 2px solid var(--line-strong); background: var(--surface); font: 800 14px var(--f-display); flex: none; }
  .current { color: var(--text); }
  .current .n { background: var(--primary); border-color: var(--primary-edge); color: var(--on-primary); box-shadow: 0 2px 0 var(--primary-edge); }
  .done .n { background: var(--ok-soft); border-color: var(--ok); color: var(--ok); }
  .fail { color: var(--bad); }
  .current.fail .n { background: var(--bad-soft); border-color: var(--bad); color: var(--bad); box-shadow: none; }
  .line { width: 32px; height: 2px; background: var(--line-strong); }
  @media (max-width: 760px) { .line { width: 16px; } .step:not(.current) .name { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; } }
  /* Phone: four progress segments (Patcher-Android); text stays available to screen readers. */
  @media (max-width: 600px) {
    .stepper { flex: 1 0 100%; order: 3; }
    ol { gap: 6px; flex-wrap: nowrap; }
    .line { display: none; }
    .step { flex: 1; height: 6px; border-radius: 999px; background: var(--surface-3); position: relative; }
    .step.done, .step.current { background: var(--primary); }
    .step.fail { background: var(--bad); }
    .step .n, .step .name { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  }
</style>
