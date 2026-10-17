<script lang="ts">
  import { t, lang, setLanguage, languageNames } from '$lib/i18n';
</script>

<label class="field">
  <span>{$t('lang.label')}</span>
  <select onchange={(e) => setLanguage(e.currentTarget.value)}>
    {#each Object.entries(languageNames) as [code, name] (code)}
      <option value={`${code}`} selected={code === $lang}>{`${name}`}</option>
    {/each}
  </select>
</label>

<style>
  .field { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.9rem; }
</style>
