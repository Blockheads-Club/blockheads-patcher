<script lang="ts">
  import logo from '$lib/assets/logo.svg';
  import { t } from '$lib/i18n';
  import { describeError } from '$lib/errors';
  import type { PatcherState } from '$lib/state.svelte';
  import LegalNotice from './LegalNotice.svelte';
  import LanguageSelect from './LanguageSelect.svelte';
  import ThemeSelect from './ThemeSelect.svelte';
  import ApkPicker from './ApkPicker.svelte';
  import PatchList from './PatchList.svelte';
  import ProgressBar from './ProgressBar.svelte';
  import ResultPanel from './ResultPanel.svelte';
  import KeyManager from './KeyManager.svelte';

  let { state: s }: { state: PatcherState } = $props();
  let view = $state<'patch' | 'keys'>('patch');

  const steps = ['step.choose', 'step.review', 'step.patch', 'step.done'] as const;
  const info = $derived(s.loaded?.info);
</script>

<div class="page">
  <header>
    <div class="brand">
      <img class="logo" src={logo} alt="" width="48" height="48" />
      <div>
      <h1>{$t('app.title')}</h1>
      <p class="muted tagline">{$t('app.tagline')}</p>
      </div>
    </div>
    <div class="controls"><LanguageSelect /><ThemeSelect /></div>
  </header>

  <LegalNotice />

  <nav aria-label={$t('nav.label')} class="tabs">
    <button type="button" aria-current={view === 'patch' ? 'page' : undefined} class:active={view === 'patch'} onclick={() => (view = 'patch')}>{$t('nav.patch')}</button>
    <button type="button" aria-current={view === 'keys' ? 'page' : undefined} class:active={view === 'keys'} onclick={() => (view = 'keys')}>{$t('nav.keys')}</button>
  </nav>

  <main>
    {#if view === 'keys'}
      <KeyManager engine={s.engine} platform={s.platform} />
    {:else}
      <ol class="steps" aria-label={$t('steps.label')}>
        {#each steps as key, i (key)}
          <li aria-current={s.step === i + 1 ? 'step' : undefined} class:done={s.step > i + 1} class:current={s.step === i + 1}>
            <span class="num">{i + 1}</span> {$t(key)}
          </li>
        {/each}
      </ol>

      {#if s.error}<p role="alert" class="error">{describeError($t, s.error)}</p>{/if}

      {#if s.step === 1}
        <ApkPicker platform={s.platform} busy={s.loading} onpicked={(p) => s.load(p)} />
      {:else if (s.stage === 'loaded' || s.stage === 'error') && info}
        <section aria-labelledby="game-title" class="card">
          <h2 id="game-title">{$t('game.title')}</h2>
          <dl>
            <dt>{$t('game.package')}</dt><dd>{info.packageName}</dd>
            <dt>{$t('game.versionLabel')}</dt>
            <dd data-testid="game-version">{$t('game.version', { name: info.versionName ?? $t('game.unknown'), code: info.versionCode ?? $t('game.unknown') })}</dd>
            <dt>{$t('game.file')}</dt><dd>{s.picked?.name}</dd>
            <dt>{$t('game.sha')}</dt><dd><code class="sha">{info.sha256}</code></dd>
          </dl>
          {#if info.packageName !== 'com.noodlecake.blockheads'}<p class="error">{$t('patches.notGame')}</p>{/if}
        </section>
        <section class="card"><PatchList report={s.report} bind:selected={s.selected} /></section>
        <div class="row">
          <button type="button" onclick={() => s.reset()}>{$t('action.back')}</button>
          <button type="button" class="primary" disabled={s.selected.length === 0} onclick={() => s.run()}>{$t('action.patch')}</button>
        </div>
      {:else if s.stage === 'patching'}
        <section class="card"><ProgressBar stage={s.progress.stage} fraction={s.progress.fraction} /></section>
        <div class="row"><button type="button" onclick={() => s.cancel()}>{$t('action.cancel')}</button></div>
      {:else if s.stage === 'done' && s.result}
        <section class="card"><ResultPanel platform={s.platform} result={s.result} onreset={() => s.reset()} /></section>
      {/if}
    {/if}
  </main>
</div>

<style>
  .page { max-width: 46rem; margin: 0 auto; padding: 1rem 16px 3rem; display: grid; gap: 1rem; }
  .brand { display: flex; gap: 0.75rem; align-items: center; }
  .logo { border-radius: 12px; flex: none; }
  header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.75rem; align-items: flex-start; }
  .tagline { margin: 0.25rem 0 0; }
  .controls { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .tabs { display: flex; gap: 0.5rem; }
  .tabs button.active { background: var(--accent-bg); border-color: var(--accent); }
  main { display: grid; gap: 1rem; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1rem; }
  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; font-size: 0.9rem; color: var(--muted); }
  .steps .current { color: var(--fg); font-weight: 600; }
  .steps .done { color: var(--ok); }
  .num { display: inline-grid; place-items: center; width: 1.5rem; height: 1.5rem; border-radius: 50%; border: 1px solid currentColor; font-size: 0.8rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 0; }
  dt { color: var(--muted); } dd { margin: 0; min-width: 0; }
  .sha { word-break: break-all; font-size: 0.8rem; }
  .row { display: flex; gap: 0.5rem; justify-content: space-between; }
</style>
