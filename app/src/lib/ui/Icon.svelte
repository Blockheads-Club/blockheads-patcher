<script lang="ts">
  let { name, size = 20, class: cls = '' }: { name: string; size?: number; class?: string } = $props();
</script>

<svg class={['ico', cls]} width={size} height={size} aria-hidden="true" focusable="false"><use href={`#i-${name}`}></use></svg>

<style>
  .ico { flex: none; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
</style>
