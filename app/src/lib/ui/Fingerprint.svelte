<script lang="ts">
  /** SHA-256 fingerprint as 32 hex pairs in an 8-column grid (monospace). */
  let { pairs, labelledby }: { pairs: string[]; labelledby?: string } = $props();
</script>

<div class="fp" role="group" aria-labelledby={labelledby} data-testid="fingerprint">
  {#each pairs as pair, i (i)}<span>{pair}</span>{/each}
</div>

<style>
  .fp { display: grid; grid-template-columns: repeat(8, auto); gap: 4px 10px; font: 600 14px/1.6 var(--f-mono); justify-content: start; background: var(--surface-2); border-radius: 10px; padding: 10px 14px; overflow-x: auto; }
  @media (max-width: 420px) { .fp { grid-template-columns: repeat(4, auto); } }
</style>
