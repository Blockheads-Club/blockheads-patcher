<script lang="ts">
  import type { Snippet } from 'svelte';

  /** Sticky bottom bar: secondary action on the left, note + primary action on the right (stacks on phones). */
  let { start, end }: { start?: Snippet; end?: Snippet } = $props();
</script>

<footer class="actions">
  <div class="s">{#if start}{@render start()}{/if}</div>
  <div class="e">{#if end}{@render end()}{/if}</div>
</footer>

<style>
  .actions { position: sticky; bottom: 0; z-index: 5; display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; padding: 14px 20px max(14px, env(safe-area-inset-bottom)); border-top: 2px solid var(--line); background: var(--surface); }
  .s, .e { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  @media (max-width: 600px) {
    .actions { flex-direction: column-reverse; align-items: stretch; padding-inline: 18px; }
    .s, .e { flex-direction: column-reverse; align-items: stretch; }
    .actions :global(.btn) { width: 100%; }
    .e :global(.hint) { text-align: center; }
  }
</style>
