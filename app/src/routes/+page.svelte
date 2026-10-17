<script lang="ts">
  import { t } from '$lib/i18n';
  import { getPlatform } from '$lib/platform';
  import { createEngine } from '$lib/engine';
  import { PatcherState } from '$lib/state.svelte';
  import App from '$lib/components/App.svelte';

  const state = new PatcherState(getPlatform(), createEngine());
  $effect(() => { document.title = $t('app.title'); });
</script>

<App {state} />
