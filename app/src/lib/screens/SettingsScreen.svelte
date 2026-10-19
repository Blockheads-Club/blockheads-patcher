<script lang="ts">
  import { t } from '$lib/i18n';
  import { applyTheme, loadTheme, type ThemeMode } from '$lib/theme.svelte';
  import { REPO_URL, WEBSITE, CREDIT_SOURCE } from '$lib/links';
  import type { Prefs } from '$lib/prefs.svelte';
  import type { PlatformAdapter, PlatformKind } from '$lib/platform/types';
  import type { PacksState } from '$lib/packs.svelte';
  import PacksSection from './PacksSection.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import LanguageSelect from '$lib/ui/LanguageSelect.svelte';
  import Segmented from '$lib/ui/Segmented.svelte';
  import Switch from '$lib/ui/Switch.svelte';
  import logo from '$lib/assets/patcher-icon-macos.svg';

  let { prefs, platformKind, packs, platform, onback, onlegal }: {
    prefs: Prefs; platformKind: PlatformKind; packs?: PacksState; platform?: PlatformAdapter; onback: () => void; onlegal: () => void;
  } = $props();

  let theme = $state<ThemeMode>(loadTheme());
  $effect(() => { applyTheme(theme); });

  const platformName = $derived($t(platformKind === 'web' ? 'platform.web' : platformKind === 'tauri-android' ? 'platform.android' : 'platform.desktop'));
  const LICENCES = [
    ['Blockheads Patcher', 'GPL-3.0-only'],
    ['Tauri', 'MIT / Apache-2.0'],
    ['Svelte, SvelteKit', 'MIT'],
    ['Bricolage Grotesque · Atkinson Hyperlegible Next · JetBrains Mono', 'OFL-1.1']
  ] as const;
</script>

<Button variant="ghost" icon="chev-l" class="back" onclick={onback}>{$t('nav.back')}</Button>
<h1>{$t('settings.title')}</h1>

<Card tag="section" class="grp" aria-labelledby="s-g">
  <h2 id="s-g">{$t('settings.general')}</h2>
  <div class="row">
    <div class="rl"><p class="rt">{$t('lang.label')}</p><p class="hint">{$t('settings.langHint')} <a href={REPO_URL} target="_blank" rel="noopener noreferrer">{$t('settings.helpTranslate')}</a></p></div>
    <LanguageSelect id="s-lang" />
  </div>
  <div class="row">
    <div class="rl"><p class="rt" id="s-th">{$t('theme.label')}</p><p class="hint">{$t('settings.themeHint')}</p></div>
    <Segmented bind:value={theme} labelledby="s-th" options={[
      { value: 'light', label: $t('theme.light'), icon: 'sun' },
      { value: 'dark', label: $t('theme.dark'), icon: 'moon' },
      { value: 'system', label: $t('theme.system'), icon: 'monitor' }
    ]} />
  </div>
</Card>

<Card tag="section" class="grp" aria-labelledby="s-p">
  <h2 id="s-p">{$t('settings.patching')}</h2>
  <div class="row"><Switch id="sw-log" bind:checked={() => prefs.showLog, (v) => prefs.setShowLog(v)} label={$t('settings.log')} hint={$t('settings.logHint')} /></div>
</Card>

{#if packs && platform}<PacksSection {packs} {platform} />{/if}

<Card tag="section" class="grp" aria-labelledby="s-a">
  <h2 id="s-a">{$t('settings.about')}</h2>
  <div class="row">
    <div class="rl app"><img src={logo} alt="" width="48" height="48" /><div><p class="rt">{$t('app.title')}</p><p class="hint selectable" data-testid="app-version">{$t('settings.version', { version: __APP_VERSION__, platform: platformName })}</p></div></div>
  </div>
  <div class="row"><div class="rl"><p class="rt">{$t('settings.source')}</p><p class="hint">{$t('settings.sourceHint')}</p></div><Button size="sm" icon="code" href={REPO_URL} external>{$t('settings.github')}</Button></div>
  <div class="row"><div class="rl"><p class="rt">{$t('settings.website')}</p></div><Button size="sm" icon="globe" href={WEBSITE} external>{$t('settings.openWebsite')}</Button></div>
</Card>

<Card tag="section" class="grp" aria-labelledby="s-l">
  <h2 id="s-l">{$t('settings.legal')}</h2>
  <div class="row"><div class="rl"><p class="rt">{$t('settings.legalNotice')}</p><p class="hint">{$t('settings.legalHint')}</p></div><Button size="sm" onclick={onlegal}>{$t('settings.readNotice')}<Icon name="chev-r" /></Button></div>
  <div class="row col">
    <p class="rt lh">{$t('settings.licences')}</p>
    {#each LICENCES as [name, licence] (name)}<div class="lic"><span>{name}</span><span class="hint">{licence}</span></div>{/each}
  </div>
</Card>

<Card tag="section" class="grp" aria-labelledby="s-c">
  <h2 id="s-c">{$t('settings.credits')}</h2>
  <div class="row col">
    <p class="hint">{$t('settings.creditsHint')}</p>
    <p class="hint selectable">{$t('credit.line', { source: CREDIT_SOURCE })}</p>
  </div>
</Card>

<style>
  :global(.back) { align-self: flex-start; --btn-px: 4px; }
  h1 { font-size: 34px; }
  :global(.grp) { --card-pad: 6px 22px; }
  :global(.grp) h2 { font-size: 19px; padding: 16px 0 6px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 0; border-top: 1px solid var(--line); flex-wrap: wrap; }
  h2 + .row { border-top: 0; }
  .row.col { flex-direction: column; align-items: stretch; gap: 0; }
  .rl { flex: 1 1 260px; min-width: 0; }
  .rt { font-weight: 700; }
  .rt.lh { padding-bottom: 6px; }
  .app { display: flex; gap: 14px; align-items: center; }
  .app img { border-radius: 11px; }
  .lic { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); font-size: 14.5px; }
</style>
