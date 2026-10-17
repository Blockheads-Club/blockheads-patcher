<script lang="ts">
  import { t } from '$lib/i18n';
  import { applyTheme, loadTheme, type ThemeMode } from '$lib/theme.svelte';

  let mode = $state<ThemeMode>(loadTheme());
  $effect(() => { applyTheme(mode); });
</script>

<label class="field">
  <span>{$t('theme.label')}</span>
  <select bind:value={mode}>
    <option value="system">{$t('theme.system')}</option>
    <option value="light">{$t('theme.light')}</option>
    <option value="dark">{$t('theme.dark')}</option>
  </select>
</label>

<style>
  .field { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.9rem; }
</style>
