<script lang="ts">
  /** value 0..100, or null for indeterminate (animated). */
  let { value, label, valuetext, striped = false }: { value: number | null; label: string; valuetext?: string; striped?: boolean } = $props();
</script>

<div class={['bar', { striped }]} role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax="100"
  aria-valuenow={value ?? undefined} aria-valuetext={valuetext}>
  {#if value === null}<span class="ind"></span>{:else}<span class="fill" style:width={`${value}%`}></span>{/if}
</div>

<style>
  .bar { height: 14px; border-radius: 999px; background: var(--surface-3); overflow: hidden; border: 2px solid var(--line-strong); position: relative; }
  .fill { display: block; height: 100%; background: var(--primary); border-radius: 999px; transition: width var(--dur-fast); }
  .striped .fill { background: repeating-linear-gradient(-45deg, var(--primary) 0 10px, color-mix(in oklab, var(--primary), #fff 18%) 10px 20px); background-size: 28px 28px; animation: stripe 1s linear infinite; }
  .ind { position: absolute; top: 0; bottom: 0; width: 35%; border-radius: 999px; background: var(--primary); animation: ind 1.3s ease-in-out infinite; }
  @keyframes stripe { to { background-position: 28px 0; } }
  @keyframes ind { from { left: -35%; } to { left: 100%; } }
  @media (prefers-reduced-motion: reduce) { .ind { left: 0; width: 100%; opacity: 0.5; } }
</style>
