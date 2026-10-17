<script lang="ts">
  import { t } from '$lib/i18n';
  import type { ApplicableReport } from '$lib/engine';
  import { describeReason } from '$lib/errors';

  let { report, selected = $bindable([]) }: { report: ApplicableReport; selected: string[] } = $props();

  function toggle(id: string, on: boolean) {
    selected = on ? [...selected.filter((x) => x !== id), id] : selected.filter((x) => x !== id);
  }
</script>

<section aria-labelledby="patches-title">
  <h2 id="patches-title">{$t('patches.title')}</h2>
  {#if report.length === 0}
    <p class="muted">{$t('patches.none')}</p>
  {:else}
    <ul class="patches">
      {#each report as { patch, status, reason, reasonCode } (patch.id)}
        <li class:disabled={status !== 'notApplied'}>
          <label>
            <input type="checkbox" checked={selected.includes(patch.id)} onchange={(e) => toggle(patch.id, e.currentTarget.checked)} disabled={status !== 'notApplied'} />
            <span class="body">
              <span class="name">{$t(patch.nameKey)}</span>
              <span class={['badge', status]} data-status={status}>{$t(`status.${status}`)}</span>
              <span class="desc muted">{$t(patch.descriptionKey)}</span>
              {#if reasonCode}<span class="desc muted">{describeReason($t, reasonCode)}</span>{:else if reason}<span class="desc muted">{reason}</span>{/if}
            </span>
          </label>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .patches { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
  li { border: 1px solid var(--border); border-radius: 10px; padding: 0.75rem; }
  li.disabled { opacity: 0.75; }
  label { display: flex; gap: 0.75rem; align-items: flex-start; }
  input { margin-top: 0.3rem; width: 1.2rem; height: 1.2rem; flex: none; }
  .body { display: flex; flex-wrap: wrap; gap: 0.25rem 0.6rem; align-items: baseline; }
  .name { font-weight: 600; }
  .desc { flex-basis: 100%; font-size: 0.9rem; }
  .badge { font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 999px; border: 1px solid currentColor; }
  .badge.notApplied { color: var(--ok); }
  .badge.applied { color: var(--accent); }
  .badge.incompatible { color: var(--danger); }
</style>
