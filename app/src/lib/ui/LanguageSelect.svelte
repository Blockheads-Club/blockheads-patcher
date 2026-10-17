<script lang="ts">
  import { t, lang, setLanguage, languageNames } from '$lib/i18n';
  import Icon from './Icon.svelte';

  let { id, iconLeft = false, class: cls = '' }: { id: string; iconLeft?: boolean; class?: string } = $props();
</script>

<div class={['ls', cls, { left: iconLeft }]}>
  <label class="sr-only" for={id}>{$t('lang.label')}</label>
  {#if iconLeft}<Icon name="globe" class="gl" />{/if}
  <select {id} onchange={(e) => setLanguage(e.currentTarget.value)}>
    {#each Object.entries(languageNames) as [code, name] (code)}<option value={`${code}`} lang={`${code}`} selected={code === $lang}>{`${name}`}</option>{/each}
  </select>
  <Icon name="chev-d" class="cv" />
</div>

<style>
  .ls { position: relative; display: inline-block; }
  select { appearance: none; min-height: 44px; padding: 0 40px 0 14px; border: 2px solid var(--line-strong); border-radius: var(--r-md); background: var(--surface); color: var(--text); font: 600 15px var(--f-body); box-shadow: var(--edge); cursor: pointer; }
  .left select { padding-inline-start: 40px; }
  .ls :global(.cv) { position: absolute; inset-inline-end: 12px; top: 12px; pointer-events: none; }
  .ls :global(.gl) { position: absolute; inset-inline-start: 12px; top: 12px; pointer-events: none; }
</style>
