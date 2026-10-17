<script lang="ts">
  import Icon from './Icon.svelte';

  /** Tilted (-6deg) icon tile used for empty/error/success states, like the logo's head angle. */
  let { icon, tone = 'sun', size = 84 }: { icon: string; tone?: 'sun' | 'bad' | 'ok' | 'primary' | 'surface'; size?: number } = $props();
</script>

<span class={['blob', tone]} style:width={`${size}px`} style:height={`${size}px`} style:border-radius={`${Math.round(size * 0.26)}px`}>
  <Icon name={icon} size={Math.round(size * 0.48)} />
</span>

<style>
  .blob { display: grid; place-items: center; transform: rotate(-6deg); box-shadow: 0 4px 0 rgba(0, 0, 0, 0.18); flex: none; }
  .blob :global(.ico) { stroke-width: 2.25; }
  .sun { background: var(--sun); color: var(--on-sun); }
  .bad { background: var(--bad-soft); color: var(--bad); border: 2px solid var(--bad); }
  .ok { background: var(--ok); color: #fff; }
  .primary { background: var(--primary); color: var(--on-primary); }
  .surface { background: var(--surface-3); color: var(--text-2); }
</style>
