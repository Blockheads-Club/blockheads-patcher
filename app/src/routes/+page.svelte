<script lang="ts">
  import { t } from '$lib/i18n';
  import { getPlatform } from '$lib/platform';
  import { createEngine } from '$lib/engine';
  import { PatcherState } from '$lib/state.svelte';
  import { IndexedDbKeyLibrary, KeysState } from '$lib/keys.svelte';
  import { Prefs } from '$lib/prefs.svelte';
  import App from '$lib/components/App.svelte';

  const engine = createEngine();
  const state = new PatcherState(getPlatform(), engine);
  const keys = new KeysState(engine, new IndexedDbKeyLibrary());
  const prefs = new Prefs();
  $effect(() => { document.title = $t('app.title'); });
</script>

<App {state} {keys} {prefs} />
