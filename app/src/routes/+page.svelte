<script lang="ts">
  import { tick } from 'svelte';
  import { lang, t } from '$lib/i18n';
  import { getPlatform } from '$lib/platform';
  import { createEngine } from '$lib/engine';
  import { PatcherState } from '$lib/state.svelte';
  import { IndexedDbKeyLibrary, KeysState } from '$lib/keys.svelte';
  import { Prefs } from '$lib/prefs.svelte';
  import { PacksState } from '$lib/packs.svelte';
  import { Boot, bootWork } from '$lib/boot.svelte';
  import { createUpdateState } from '$lib/update.svelte';
  import { splashIpc } from '$lib/splash';
  import App from '$lib/components/App.svelte';
  import SplashScreen from '$lib/screens/SplashScreen.svelte';

  const platform = getPlatform();
  const engine = createEngine();
  const patcher = new PatcherState(platform, engine);
  const keys = new KeysState(engine, new IndexedDbKeyLibrary());
  const prefs = new Prefs();
  const packs = new PacksState(platform.packStore, engine, () => patcher.refresh());
  const boot = new Boot(() => bootWork(keys, packs));
  const update = createUpdateState(platform);
  /** Desktop: a separate splash window shows the boot while this (hidden) window does the work. */
  const windowed = platform.kind === 'tauri-desktop';
  const android = platform.kind === 'tauri-android';
  let showDetail = $state(false);

  // A found update also shows in the browser tab (the web app has no title bar of its own).
  $effect(() => { document.title = (update.stage === 'available' ? '↑ ' : '') + $t('app.title'); });

  $effect(() => {
    void boot.run();
    if (!windowed) return;
    let off: (() => void) | undefined;
    let gone = false;
    splashIpc.onRetry(() => { showDetail = false; void boot.run(); }).then((u) => (gone ? u() : (off = u))).catch(() => {});
    return () => { gone = true; off?.(); };
  });

  // The static start-up card from app.html: faded out once the app is up; for the slow and error states the
  // identical Svelte card underneath takes over, so the static one just goes.
  $effect(() => {
    const card = document.getElementById('boot-splash');
    if (!card || boot.phase === 'loading') return;
    if (boot.phase === 'ready') {
      card.classList.add('bs-fade');
      setTimeout(() => card.remove(), 220);
    } else card.remove();
  });

  // Mirror the boot state into the splash window, and reveal the main window once the boot is done.
  $effect(() => {
    if (!windowed) return;
    const { phase, error } = boot;
    if (phase === 'ready') {
      void tick().then(() => splashIpc.mainReady()).catch(() => {});
      return;
    }
    void splashIpc.set({ boot: phase, error, version: __APP_VERSION__, lang: $lang }).catch(() => {});
  });
</script>

{#if boot.phase === 'ready'}
  <App state={patcher} {keys} {prefs} {packs} {update} />
{:else if android}
  <SplashScreen variant="phone" phase={boot.phase} onretry={() => void boot.run()} />
{:else}
  <div class="host">
    <SplashScreen
      phase={boot.phase}
      version={__APP_VERSION__}
      detail={showDetail ? boot.error : ''}
      onretry={() => { showDetail = false; void boot.run(); }}
      onopenlog={() => (showDetail = !showDetail)}
    />
  </div>
{/if}

<style>
  .host { position: fixed; inset: 0; display: grid; place-items: center; background: var(--bg); padding: 16px; }
</style>
