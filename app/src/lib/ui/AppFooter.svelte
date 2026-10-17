<script lang="ts">
  import { t } from '$lib/i18n';
  import { shortFingerprint } from '$lib/format';
  import type { PlatformKind } from '$lib/platform/types';
  import type { KeyView } from '$lib/keys.svelte';
  import Icon from './Icon.svelte';

  let { platformKind, activeKey }: { platformKind: PlatformKind; activeKey: KeyView | null } = $props();
</script>

<footer class="sbar">
  <span class="l"><Icon name={platformKind === 'web' ? 'shield' : 'wifi-off'} size={16} />{platformKind === 'web' ? $t('footer.browser') : $t('footer.offline')}</span>
  <span class="fan" data-testid="legal-notice">{$t('footer.fan')}</span>
  <span class="r">
    {$t('footer.version', { version: __APP_VERSION__ })} ·
    {activeKey ? $t('footer.key', { name: activeKey.name || $t('keys.defaultName'), fingerprint: shortFingerprint(activeKey.fingerprint, 2, 1) }) : $t('footer.keyNew')}
  </span>
</footer>

<style>
  .sbar { border-top: 2px solid var(--line); padding: 10px 20px max(10px, env(safe-area-inset-bottom)); display: flex; gap: 8px 16px; font-size: 13.5px; color: var(--text-3); justify-content: space-between; flex-wrap: wrap; background: var(--surface); }
  .l { display: inline-flex; gap: 8px; align-items: center; }
  .fan { flex: 1 1 280px; text-align: center; }
  @media (max-width: 600px) { .sbar { justify-content: center; text-align: center; } .fan { flex-basis: 100%; order: 3; } }
</style>
