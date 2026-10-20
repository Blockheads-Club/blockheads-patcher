<script lang="ts">
  import { t, lang } from '$lib/i18n';
  import { describeError } from '$lib/errors';
  import { formatBytes, shortFingerprint } from '$lib/format';
  import { GUIDES_URL } from '$lib/links';
  import type { PatchApkResult } from '$lib/engine';
  import type { PlatformAdapter } from '$lib/platform/types';
  import type { KeysState } from '$lib/keys.svelte';
  import Badge from '$lib/ui/Badge.svelte';
  import Blob from '$lib/ui/Blob.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Callout from '$lib/ui/Callout.svelte';
  import Card from '$lib/ui/Card.svelte';
  import InstallFlow from './InstallFlow.svelte';

  let { platform, result, keys, onreset, onopenkeys }: {
    platform: PlatformAdapter; result: PatchApkResult; keys: KeysState; onreset: () => void; onopenkeys: () => void;
  } = $props();

  const fingerprint = $derived(result.certSha256.toUpperCase().match(/../g)!.join(':'));
  const keyName = $derived(keys.keys.find((k) => k.fingerprint === fingerprint)?.name || $t('keys.defaultName'));
  const version = $derived(result.info.versionName ?? '');
  const lead = $derived($t('result.lead', { n: result.applied.length, version }));

  let note = $state<string | null>(null);
  let error = $state<string | null>(null);

  async function save() {
    error = null; note = null;
    try {
      const r = await platform.saveOutput(result.suggestedFileName, result.bytes);
      note = r.location ? $t('result.saved', { location: r.location }) : $t('result.savedGeneric');
    } catch (e) { error = describeError($t, e); }
  }
</script>

{#if platform.installApk}
  <InstallFlow {platform} {result} {onreset} {onopenkeys} />
{:else}
  <div class="hero" role="status">
    <Blob icon="check" tone="ok" size={96} />
    <div class="ht"><h1>{$t('result.title')}</h1><p class="muted">{lead}</p></div>
  </div>

  <Card class="file">
    <div class="fi">
      <p class="fn" data-testid="result-file">{result.suggestedFileName}</p>
      <p class="hint">{$t('result.signed', { size: formatBytes(result.bytes.length, $lang), key: keyName, fingerprint: shortFingerprint(fingerprint, 2, 1) })}</p>
      <details class="cert"><summary>{$t('result.cert')}</summary><p class="hint mono fp" data-testid="result-cert">{fingerprint}</p></details>
    </div>
    <div class="fb">
      <Badge tone="sun">{$t('badge.fan')}</Badge>
      <Button variant="primary" size="lg" icon="download" onclick={save}>{$t('result.save')}</Button>
    </div>
  </Card>
  <p class="hint">{platform.kind === 'web' ? $t('result.saveHintWeb') : $t('result.saveHintDesktop')}</p>
  {#if note}<Callout tone="ok" role="status">{note}</Callout>{/if}
  {#if error}<Callout tone="bad" role="alert">{error}</Callout>{/if}
  {#if result.skipped.length}<p class="muted">{$t('result.skipped', { list: result.skipped.map((x) => $t(`patch.${x.id}.name`)).join(', ') })}</p>{/if}

  <Card tag="section" class="next" aria-labelledby="nx">
    <h2 id="nx">{$t('result.next')}</h2>
    <ol>
      <li><span class="num">1</span><p><strong>{$t('result.n1.title')}</strong> {$t('result.n1.body')}</p></li>
      <li><span class="num">2</span><p><strong>{$t('result.n2.title')}</strong> {$t('result.n2.body')}</p></li>
      <li><span class="num">3</span><p><strong>{$t('result.n3.title')}</strong> {$t('result.n3.body')} <a href={GUIDES_URL} target="_blank" rel="noopener noreferrer">{$t('result.fullGuide')}</a></p></li>
    </ol>
  </Card>

  <div class="end">
    <Button icon="plus" onclick={onreset}>{$t('result.again')}</Button>
    <Badge tone="info" icon="key">{$t('result.keepKey')}</Badge>
  </div>
{/if}

<style>
  .hero { display: flex; gap: 22px; align-items: center; flex-wrap: wrap; }
  .ht { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 260px; }
  h1 { font-size: 36px; }
  .ht p { font-size: 17px; }
  :global(.file) { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  .fi { flex: 1; min-width: 240px; }
  .fn { font-weight: 700; overflow-wrap: anywhere; }
  .fp { overflow-wrap: anywhere; font-size: 12px; }
  .cert summary { cursor: pointer; font-size: 13.5px; font-weight: 700; color: var(--primary-ink); min-height: 32px; display: inline-flex; align-items: center; }
  .fb { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  :global(.next) { --card-pad: 8px 22px; }
  :global(.next) h2 { font-size: 20px; padding: 14px 0 4px; }
  ol { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 14px; align-items: flex-start; padding: 14px 0; border-bottom: 1px solid var(--line); }
  li:last-child { border-bottom: 0; }
  .num { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; background: var(--sun); color: var(--on-sun); font: 800 14px var(--f-display); transform: rotate(-6deg); box-shadow: 0 2px 0 var(--sun-edge); flex: none; }
  .end { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: center; }
</style>
