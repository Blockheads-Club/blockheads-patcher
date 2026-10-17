<script lang="ts">
  import type { Snippet } from 'svelte';

  let { tag = 'div', selected = false, muted = false, disabled = false, class: cls = '', children, ...rest }: {
    tag?: string; class?: string; selected?: boolean; muted?: boolean; disabled?: boolean; children: Snippet; [k: string]: unknown;
  } = $props();
</script>

<svelte:element this={tag} class={['card', { selected, muted, disabled }, cls]} {...rest}>{@render children()}</svelte:element>

<style>
  .card { background: var(--surface); border: 2px solid var(--line); border-radius: var(--r-lg); padding: var(--card-pad, 20px); min-width: 0; }
  .selected { border-color: var(--primary); box-shadow: 0 3px 0 color-mix(in oklab, var(--primary), transparent 60%); }
  .muted, .disabled { background: var(--surface-2); }
</style>
