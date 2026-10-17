<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  const ICONS = { info: 'shield', ok: 'check', warn: 'alert', bad: 'x' } as const;
  let { tone = 'info', title, icon, role, children, actions }: {
    tone?: 'info' | 'ok' | 'warn' | 'bad'; title?: string; icon?: string; role?: 'note' | 'alert' | 'status'; children?: Snippet; actions?: Snippet;
  } = $props();
</script>

<div class={['callout', tone]} {role}>
  <Icon name={icon ?? ICONS[tone]} class="ci" />
  <div class="body">
    {#if title}<p class="title">{title}</p>{/if}
    {#if children}<p class="text">{@render children()}</p>{/if}
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </div>
</div>

<style>
  .callout { display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; border-radius: 12px; border: 2px solid transparent; color: var(--text); }
  .callout :global(.ci) { margin-top: 2px; }
  .body { flex: 1; min-width: 0; }
  .title { font-weight: 700; }
  .text { font-size: 14.5px; color: var(--text-2); }
  .actions { margin-top: 6px; }
  .info { background: var(--info-soft); border-color: color-mix(in oklab, var(--info), transparent 70%); }
  .info :global(.ci) { color: var(--info); }
  .ok { background: var(--ok-soft); border-color: color-mix(in oklab, var(--ok), transparent 70%); }
  .ok :global(.ci) { color: var(--ok); }
  .warn { background: var(--warn-soft); border-color: color-mix(in oklab, var(--warn), transparent 65%); }
  .warn :global(.ci) { color: var(--warn); }
  .bad { background: var(--bad-soft); border-color: color-mix(in oklab, var(--bad), transparent 65%); }
  .bad :global(.ci) { color: var(--bad); }
</style>
