<script lang="ts">
  import { t } from '$lib/i18n';
  let { stage, fraction }: { stage: string; fraction: number } = $props();
  const pct = $derived(Math.round(Math.min(1, Math.max(0, fraction)) * 100));
</script>

<div class="wrap">
  <div class="label" aria-live="polite">{`${$t(`progress.${stage}`)} (${pct}%)`}</div>
  <div class="bar" role="progressbar" aria-label={$t('progress.label')} aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct}>
    <div class="fill" style:width={`${pct}%`}></div>
  </div>
</div>

<style>
  .label { font-size: 0.9rem; margin-bottom: 0.25rem; }
  .bar { height: 0.75rem; border-radius: 999px; background: var(--border); overflow: hidden; }
  .fill { height: 100%; background: var(--accent); transition: width 0.15s; }
</style>
