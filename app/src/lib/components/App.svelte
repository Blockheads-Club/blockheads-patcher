<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { t } from '$lib/i18n';
  import type { PatcherState } from '$lib/state.svelte';
  import type { KeysState } from '$lib/keys.svelte';
  import { giveConsent, hasConsent, type Prefs } from '$lib/prefs.svelte';
  import AppBar, { type View } from '$lib/ui/AppBar.svelte';
  import AppFooter from '$lib/ui/AppFooter.svelte';
  import ActionBar from '$lib/ui/ActionBar.svelte';
  import Button from '$lib/ui/Button.svelte';
  import ChooseScreen from '$lib/screens/ChooseScreen.svelte';
  import ReviewScreen from '$lib/screens/ReviewScreen.svelte';
  import ProgressScreen from '$lib/screens/ProgressScreen.svelte';
  import ResultScreen from '$lib/screens/ResultScreen.svelte';
  import FailureScreen from '$lib/screens/FailureScreen.svelte';
  import KeysScreen from '$lib/screens/KeysScreen.svelte';
  import SettingsScreen from '$lib/screens/SettingsScreen.svelte';
  import FirstRunDialog from '$lib/screens/FirstRunDialog.svelte';
  import TitleBar from '$lib/ui/TitleBar.svelte';
  import { guessOs, win } from '$lib/winctl';
  import { splashIpc } from '$lib/splash';

  let { state: s, keys, prefs }: { state: PatcherState; keys: KeysState; prefs: Prefs } = $props();

  let view = $state<View>('patch');
  let consented = $state(hasConsent());
  let legalOpen = $state(false);
  let quitHint = $state(false);
  let main: HTMLElement | undefined = $state();

  const platform = $derived(s.platform);
  const failed = $derived(s.runFailed && s.stage === 'error');
  const step = $derived(failed ? 3 : s.step);
  const info = $derived(s.loaded?.info);
  const count = $derived(s.selected.length);
  /** Desktop shell: custom title bar, rounded frame, fixed-height window where only the content scrolls. */
  const desktop = $derived(platform.kind === 'tauri-desktop');
  const os = guessOs();
  const ctx = $derived(
    view === 'keys' ? $t('tb.keys') : view === 'settings' ? $t('tb.settings')
    : failed ? $t('tb.failed') : s.step === 1 ? $t('tb.choose') : s.stage === 'patching' ? $t('tb.patching')
    : s.stage === 'done' ? $t('tb.done') : $t('tb.review')
  );
  /** Maximized or fullscreen: the window fills the screen, so no rounded corners (macOS has native ones). */
  let square = $state(false);
  const round = $derived(desktop && os !== 'macos' && !square);
  // Transparent page behind the rounded frame, so the window's corners show through (app.css, app.html).
  $effect(() => {
    document.documentElement.classList.toggle('desk', desktop);
  });
  onMount(() => {
    if (!desktop) return;
    const sync = () => void Promise.all([win.isMaximized(), win.isFullscreen()]).then(([m, f]) => (square = m || f)).catch(() => {});
    sync();
    let off: (() => void) | undefined;
    let gone = false;
    win.onResized(sync).then((u) => (gone ? u() : (off = u))).catch(() => {});
    return () => { gone = true; off?.(); };
  });
  const modal = $derived(!consented || legalOpen);

  $effect(() => { keys.refresh().catch(() => {}); });
  // Newly created signing key (first patch) shows up in the footer and Keys.
  $effect(() => { if (s.stage === 'done') keys.refresh().catch(() => {}); });

  // After a screen change, keyboard and screen reader users land on the new heading.
  let firstScreen = true;
  $effect(() => {
    void [view, step, failed];
    if (firstScreen) { firstScreen = false; return; }
    tick().then(() => {
      const h = main?.querySelector('h1');
      if (h) { h.tabIndex = -1; h.focus(); }
    });
  });

  function accept() { giveConsent(); consented = true; }
  /** Desktop: leave the app. The web can only try to close the tab (allowed only for script-opened tabs), so it
   *  also explains how to leave. */
  function quit() {
    if (desktop) { splashIpc.quit().catch(() => {}); return; }
    window.close(); quitHint = true;
  }
  const openKeys = () => { view = 'keys'; };
</script>

<a class="skip-link" href="#main" onclick={(e) => { e.preventDefault(); main?.focus(); }}>{$t('a11y.skip')}</a>

<div class={['frame', round && 'round']}>
<div class={['app', desktop && 'desk']} inert={modal}>
  {#if desktop}<TitleBar {os} {ctx} />{/if}
  <AppBar {view} {step} {failed} install={!!platform.installApk} locked={s.stage === 'patching'} onnavigate={(v) => (view = v)} />

  <main id="main" class="body" bind:this={main} tabindex="-1">
    <div class={['col', view === 'patch' ? `s${step}` : view]}>
      {#if view === 'keys'}
        <KeysScreen {keys} {platform} onback={() => (view = 'patch')} />
      {:else if view === 'settings'}
        <SettingsScreen {prefs} platformKind={platform.kind} onback={() => (view = 'patch')} onlegal={() => (legalOpen = true)} />
      {:else if failed}
        <FailureScreen state={s} onopenkeys={openKeys} />
      {:else if s.step === 1}
        <ChooseScreen state={s} />
      {:else if s.stage === 'patching'}
        <ProgressScreen state={s} {keys} {prefs} />
      {:else if s.stage === 'done' && s.result}
        <ResultScreen {platform} result={s.result} {keys} onreset={() => s.reset()} onopenkeys={openKeys} />
      {:else if info && s.picked}
        <ReviewScreen state={s} {keys} {info} file={{ name: s.picked.name, size: s.fileSize }} onchangekey={openKeys} />
      {/if}
    </div>
  </main>

  {#if view === 'patch' && !failed && s.stage === 'loaded'}
    <ActionBar>
      {#snippet start()}<Button icon="chev-l" onclick={() => s.reset()}>{$t('action.back')}</Button>{/snippet}
      {#snippet end()}
        <span class="hint">{$t('review.note')}</span>
        <Button variant="primary" size="lg" icon="patch" disabled={count === 0} onclick={() => s.run()}>
          {count === 0 ? $t('review.ctaNone') : count === 1 ? $t('review.ctaOne') : $t('review.ctaMany', { n: count })}
        </Button>
      {/snippet}
    </ActionBar>
  {/if}

  <AppFooter platformKind={platform.kind} activeKey={keys.active} />
</div>
</div>

{#if !consented}
  <FirstRunDialog {quitHint} onaccept={accept} onquit={quit} />
{:else if legalOpen}
  <FirstRunDialog review onclose={() => (legalOpen = false)} />
{/if}

<style>
  /* Native window is transparent on Windows/Linux; this frame draws the rounded window. clip-path also clips the fixed dialogs. */
  .frame.round { clip-path: inset(0 round 12px); }
  .frame.round::after { content: ''; position: fixed; inset: 0; border: 1px solid var(--line-strong); border-radius: 12px; pointer-events: none; z-index: 1000; }
  .app.desk { height: 100dvh; min-height: 0; }
  .app.desk .body { min-height: 0; overflow: auto; }
  .app { min-height: 100dvh; display: flex; flex-direction: column; background: var(--bg); }
  .body { flex: 1; display: flex; justify-content: center; padding: 32px 24px; }
  .body:focus { outline: none; }
  .col { width: 100%; max-width: 860px; display: flex; flex-direction: column; gap: 22px; }
  .col.s2 { max-width: 1040px; }
  .col.s3, .col.s4 { max-width: 760px; }
  .col.keys { max-width: 1000px; }
  .col.settings { max-width: 820px; }
  @media (max-width: 600px) { .body { padding: 18px 16px; } }
</style>
