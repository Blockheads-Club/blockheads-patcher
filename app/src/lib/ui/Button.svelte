<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  type Props = {
    variant?: 'secondary' | 'primary' | 'ghost' | 'danger' | 'quiet-danger';
    size?: 'sm' | 'md' | 'lg';
    icon?: string;
    /** Icon-only button: children are hidden visually and used as the accessible name. */
    iconOnly?: boolean;
    loading?: boolean;
    disabled?: boolean;
    href?: string;
    external?: boolean;
    type?: 'button' | 'submit';
    current?: boolean;
    class?: string;
    onclick?: (e: MouseEvent) => void;
    children: Snippet;
    [k: string]: unknown;
  };
  let { variant = 'secondary', size = 'md', icon, iconOnly = false, loading = false, disabled = false, href, external = false, type = 'button', current = false, class: cls = '', onclick, children, ...rest }: Props = $props();
  const iconSize = $derived(size === 'sm' ? 18 : 20);
</script>

{#snippet inner()}
  {#if loading}<span class="spin" aria-hidden="true"></span>{:else if icon}<Icon name={icon} size={iconSize} />{/if}
  {#if iconOnly}<span class="sr-only">{@render children()}</span>{:else}<span class="label">{@render children()}</span>{/if}
{/snippet}

{#if href}
  <a class={['btn', variant, size, { icon: iconOnly, current }, cls]} {href} aria-current={current ? 'page' : undefined} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined} {...rest}>{@render inner()}</a>
{:else}
  <button class={['btn', variant, size, { icon: iconOnly, current }, cls]} {type} {onclick} disabled={disabled || loading} aria-busy={loading || undefined} aria-current={current ? 'page' : undefined} {...rest}>{@render inner()}</button>
{/if}

<style>
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 var(--btn-px, 18px);
    border-radius: var(--r-md); border: 2px solid var(--line-strong); background: var(--surface); color: var(--text);
    font: 700 15px/1.2 var(--f-body); box-shadow: var(--edge); cursor: pointer; text-decoration: none; text-align: center;
    transition: transform var(--dur-press), box-shadow var(--dur-press), background-color var(--dur-fast);
  }
  .btn:hover { background: var(--surface-2); color: var(--text); }
  .btn:active:not(:disabled) { transform: translateY(2px); box-shadow: 0 1px 0 var(--line-strong); }
  .btn.sm { min-height: 40px; padding: 0 var(--btn-px, 12px); font-size: 14px; }
  .btn.lg { min-height: 52px; padding: 0 var(--btn-px, 24px); font-size: 16.5px; }
  .btn.icon { width: 44px; padding: 0; }
  .btn.icon.sm { width: 40px; }
  .primary { background: var(--primary); border-color: var(--primary-edge); color: var(--on-primary); box-shadow: 0 3px 0 var(--primary-edge); }
  .primary:hover { background: var(--primary-hover); color: var(--on-primary); }
  .primary:active:not(:disabled) { box-shadow: 0 1px 0 var(--primary-edge); }
  .danger { background: var(--bad); border-color: var(--bad); color: var(--on-bad); box-shadow: 0 3px 0 color-mix(in oklab, var(--bad), #000 40%); }
  .danger:hover { background: var(--bad); color: var(--on-bad); }
  .quiet-danger { color: var(--bad); }
  .quiet-danger:hover { color: var(--bad); }
  .ghost { background: transparent; border-color: transparent; box-shadow: none; color: var(--text-2); }
  .ghost:hover { background: var(--surface-2); color: var(--text); }
  .ghost.current, .ghost.current:hover { background: var(--primary-soft); color: var(--primary-ink); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }
  .btn[aria-busy='true'] { cursor: progress; opacity: 1; }
  .spin { width: 20px; height: 20px; border-radius: 50%; border: 3px solid color-mix(in oklab, currentColor, transparent 65%); border-top-color: currentColor; animation: spin 0.9s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
