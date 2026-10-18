<script lang="ts">
  import { onMount } from 'svelte';
  import { dictionaries, lang } from '$lib/i18n';
  import { splashIpc, type SplashState } from '$lib/splash';
  import SplashScreen from '$lib/screens/SplashScreen.svelte';

  /** Contents of the separate splash window (src-tauri opens it first); the hidden main window pushes the state. */
  let splash = $state<SplashState | null>(null);
  const square = navigator.userAgent.includes('Mac');

  function apply(s: SplashState) {
    if (s.lang in dictionaries) lang.set(s.lang);
    splash = s;
  }

  onMount(() => {
    let off: (() => void) | undefined;
    let gone = false;
    splashIpc.onState(apply).then((u) => (gone ? u() : (off = u))).catch(() => {});
    // The state set before this window opened; a pushed state is newer, so it wins.
    splashIpc.get().then((s) => { if (!splash) apply(s); }).catch(() => {});
    return () => { gone = true; off?.(); };
  });
</script>

<svelte:head><title>Blockheads Patcher</title></svelte:head>

{#if splash}
  <SplashScreen
    windowed
    {square}
    phase={splash.boot}
    version={splash.version}
    onretry={() => void splashIpc.retry()}
    onopenlog={() => void splashIpc.openLog()}
    onquit={() => void splashIpc.quit()}
  />
{/if}

<style>
  :global(html, body) { background: transparent; overflow: hidden; height: 100%; }
</style>
