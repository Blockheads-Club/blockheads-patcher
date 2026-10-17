<script lang="ts">
  import { t } from '$lib/i18n';
</script>

<aside class="legal" role="note" data-testid="legal-notice">
  <p>{$t('legal.notice')}</p>
  <p class="muted">{$t('privacy.note')}</p>
</aside>

<style>
  .legal { border: 1px solid var(--warn-border); background: var(--warn-bg); border-radius: 10px; padding: 0.75rem 1rem; }
  p { margin: 0; }
  p + p { margin-top: 0.25rem; }
</style>
