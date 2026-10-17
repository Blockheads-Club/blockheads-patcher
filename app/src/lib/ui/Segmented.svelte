<script lang="ts">
  import Icon from './Icon.svelte';

  type Option = { value: string; label: string; icon?: string };
  let { options, value = $bindable(), labelledby, label }: { options: Option[]; value: string; labelledby?: string; label?: string } = $props();

  function onkey(e: KeyboardEvent, i: number) {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = options[(i + step + options.length) % options.length]!;
    value = next.value;
    (e.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  }
</script>

<div class="seg" role="radiogroup" aria-labelledby={labelledby} aria-label={label}>
  {#each options as o, i (o.value)}
    <button type="button" role="radio" aria-checked={value === o.value} tabindex={value === o.value ? 0 : -1} data-value={o.value}
      onclick={() => (value = o.value)} onkeydown={(e) => onkey(e, i)}>
      {#if o.icon}<Icon name={o.icon} />{/if}{o.label}
    </button>
  {/each}
</div>

<style>
  .seg { display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 4px; background: var(--surface-2); border: 2px solid var(--line); border-radius: 14px; }
  button { min-height: 40px; padding: 0 14px; border: 0; border-radius: 10px; background: transparent; color: var(--text-2); font: 700 14px/1 var(--f-body); display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
  button[aria-checked='true'] { background: var(--surface); color: var(--text); box-shadow: 0 2px 0 var(--line-strong); }
</style>
