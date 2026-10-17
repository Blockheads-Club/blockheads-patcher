<script lang="ts">
  import '@fontsource-variable/bricolage-grotesque/opsz.css';
  import '@fontsource-variable/atkinson-hyperlegible-next/wght.css';
  import '@fontsource-variable/jetbrains-mono/wght.css';
  import '../app.css';
  import { lang } from '$lib/i18n';
  import { applyTheme, loadTheme } from '$lib/theme.svelte';
  import IconSprite from '$lib/ui/IconSprite.svelte';
  let { children } = $props();
  $effect(() => { document.documentElement.lang = $lang; });
  // Re-apply the saved theme at startup (the Settings screen is not mounted yet).
  applyTheme(loadTheme());
</script>

<IconSprite />
{@render children()}
