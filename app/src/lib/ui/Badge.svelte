<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  let { tone = 'neutral', icon, dot = false, children }: {
    tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'primary' | 'sun'; icon?: string; dot?: boolean; children: Snippet;
  } = $props();
</script>

<span class={['badge', tone]}>
  {#if icon}<Icon name={icon} size={14} />{:else if dot}<span class="dot" aria-hidden="true"></span>{/if}
  {@render children()}
</span>

<style>
  .badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font: 700 12.5px/1.4 var(--f-body); background: var(--surface-2); color: var(--text-2); }
  .ok { background: var(--ok-soft); color: var(--ok); }
  .warn { background: var(--warn-soft); color: var(--warn); }
  .bad { background: var(--bad-soft); color: var(--bad); }
  .info { background: var(--info-soft); color: var(--info); }
  .primary { background: var(--primary-soft); color: var(--primary-ink); }
  .sun { background: var(--sun); color: var(--on-sun); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
</style>
