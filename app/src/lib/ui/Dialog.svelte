<script lang="ts">
  import type { Snippet } from 'svelte';

  let { labelledby, describedby, onclose, children }: { labelledby: string; describedby?: string; onclose?: () => void; children: Snippet } = $props();

  let root: HTMLElement | undefined = $state();
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  // Focus moves into the dialog on open and returns to the opener on close.
  $effect(() => {
    const opener = document.activeElement as HTMLElement | null;
    (root?.querySelector<HTMLElement>('[data-autofocus]') ?? root?.querySelector<HTMLElement>(FOCUSABLE) ?? root)?.focus();
    return () => opener?.focus?.();
  });

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && onclose) { e.stopPropagation(); onclose(); return; }
    if (e.key !== 'Tab' || !root) return;
    const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0], last = items[items.length - 1];
    if (!first || !last) { e.preventDefault(); return; }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === root)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }
</script>

<div class="scrim">
  <div bind:this={root} class="dlg" role="dialog" aria-modal="true" aria-labelledby={labelledby} aria-describedby={describedby} tabindex="-1" {onkeydown}>
    {@render children()}
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 50; background: var(--scrim); display: flex; align-items: center; justify-content: center; padding: 24px; }
  .dlg { background: var(--surface); border: 2px solid var(--line-strong); border-radius: var(--r-xl); box-shadow: var(--lift); width: 100%; max-width: 600px; max-height: calc(100dvh - 48px); overflow: auto; display: flex; flex-direction: column; animation: land var(--dur-move) var(--ease-block); }
  .dlg:focus { outline: none; }
  @keyframes land { from { transform: translateY(12px) scale(0.98); opacity: 0; } }
  @media (max-width: 600px) { .scrim { padding: 12px; align-items: flex-end; } .dlg { max-height: calc(100dvh - 24px); } }
</style>
