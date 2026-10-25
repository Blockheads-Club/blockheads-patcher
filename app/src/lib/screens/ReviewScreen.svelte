<script lang="ts">
  import { t, lang } from '$lib/i18n';
  import { describeReason } from '$lib/errors';
  import { formatBytes, shortFingerprint } from '$lib/format';
  import type { ApkInfo, Patch, PatchStatus } from '@bh-patcher/core';
  import { patchVersionText } from '$lib/versions';
  import type { MessageKey } from '$lib/i18n';
  import type { PatcherState } from '$lib/state.svelte';
  import type { KeysState } from '$lib/keys.svelte';
  import { displayOrder } from '$lib/patch-order';
  import Badge from '$lib/ui/Badge.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Icon from '$lib/ui/Icon.svelte';

  let { state: s, keys, info, file, onchangekey }: { state: PatcherState; keys: KeysState; info: ApkInfo; file: { name: string; size: number }; onchangekey: () => void } = $props();

  const version = $derived(info.versionName ?? '?');
  const versionText = $derived(info.versionCode ? `${version} (${info.versionCode})` : version);
  const shaPairs = $derived(info.sha256.match(/../g)!.join(':'));
  const compat = $derived(s.report.filter((r) => r.status !== 'incompatible').length);

  function toggle(id: string, on: boolean) {
    s.selected = on ? [...s.selected.filter((x) => x !== id), id] : s.selected.filter((x) => x !== id);
  }
  const updateText = (patch: Patch, from: number | undefined) =>
    from === undefined ? $t('badge.updateTo', { to: patchVersionText(patch, patch.version) })
      : $t('badge.update', { from: patchVersionText(patch, from), to: patchVersionText(patch, patch.version) });
  const statusBadge = (status: PatchStatus): MessageKey => (status === 'applied' ? 'badge.applied' : status === 'outdated' ? 'badge.updateBlocked' : 'badge.notForVersion');
  const summary = (id: string) => `patch.${id}.summary` as MessageKey;
  /** Optional "when you need it" line of a patch (`patch.<id>.when`). */
  const when = (id: string) => `patch.${id}.when` as MessageKey;
  /** The pack's name in the UI language (from its texts), else the English name the patch carries. */
  const packName = (src: { packId: string; packName: string }) => {
    const key = `pack.${src.packId}.name`;
    const name = $t(key);
    return name === key ? src.packName : name;
  };
</script>

<div class="head">
  <h1>{$t('review.title')}</h1>
  <p class="muted lead">{$t('review.lead')}</p>
</div>

<div class="split">
  <Card tag="section" class="info" aria-labelledby="gi">
    <div class="gh">
      <span class="gi"><Icon name="file" size={26} /></span>
      <div>
        <h2 id="gi">{$t('review.game')}</h2>
        <Badge tone="ok" icon="check">{$t('review.detected', { version })}</Badge>
      </div>
    </div>
    <dl class="kv">
      <dt>{$t('review.version')}</dt><dd class="mono" data-testid="game-version">{versionText}</dd>
      <dt>{$t('review.package')}</dt><dd class="mono">{info.packageName}</dd>
      <dt>{$t('review.file')}</dt><dd>{file.name}</dd>
      <dt>{$t('review.size')}</dt><dd>{formatBytes(file.size, $lang)}</dd>
      <dt>{$t('review.sha')}</dt><dd class="mono sha">{shortFingerprint(shaPairs, 4, 4)}</dd>
    </dl>
    <div class="sign">
      <p class="sl">{$t('review.willSign')}</p>
      <div class="key">
        <span class="ki"><Icon name="key" /></span>
        <div class="kt">
          <p class="kn">{keys.active ? keys.active.name || $t('keys.defaultName') : $t('review.newKey')}</p>
          <p class="hint mono">{keys.active ? shortFingerprint(keys.active.fingerprint, 3, 2) : $t('review.newKeyHint')}</p>
        </div>
      </div>
      <Button size="sm" onclick={onchangekey} class="chg">{$t('review.change')}</Button>
    </div>
  </Card>

  <section class="patches" aria-labelledby="pl">
    <div class="ph">
      <h2 id="pl">{$t('review.patchesFor', { version })}</h2>
      <span class="hint" aria-live="polite">{$t('review.count', { n: s.selected.length, total: compat })}</span>
    </div>
    {#if s.report.length === 0}
      <p class="muted">{$t('review.none')}</p>
    {/if}
    {#if s.resignOnly}
      <Card class="resign" role="note"><p>{$t('review.resignNote')}</p></Card>
    {/if}
    {#each displayOrder(s.report) as { patch, status, reasonCode, reason, fromVersion, canUpgrade } (patch.id)}
      {#if status === 'notApplied' || (status === 'outdated' && canUpgrade)}
        <Card tag="label" class="patch" selected>
          <input type="checkbox" class="chk" checked={s.selected.includes(patch.id)} aria-describedby={`pd-${patch.id}`}
            onchange={(e) => toggle(patch.id, e.currentTarget.checked)} />
          <div class="pb">
            <div class="pt">
              <span class="ptitle">{$t(patch.nameKey)}</span>
              {#if patch.source}<Badge tone="sun">{$t('badge.pack')}</Badge>{:else if patch.optIn}<Badge tone="info">{$t('badge.optional')}</Badge>{:else}<Badge tone="primary" icon="star">{$t('badge.recommended')}</Badge>{/if}
              {#if status === 'outdated'}<Badge tone="sun" icon="refresh">{updateText(patch, fromVersion)}</Badge>
              {:else}<Badge tone="ok" icon="check">{$t('badge.compatible')}</Badge>{/if}
              {#if patch.optIn && patch.source}<Badge tone="info">{$t('review.optIn')}</Badge>{/if}
            </div>
            <p id={`pd-${patch.id}`} class="muted desc">{$t(summary(patch.id))}</p>
            {#if status === 'outdated'}<p class="hint when">{$t('review.updateNote')}</p>{/if}
            <details class="more">
              <summary><Icon name="chev-d" size={16} />{$t('review.whatChanges')}</summary>
              {#if $t(when(patch.id)) !== when(patch.id)}<p class="hint when">{$t(when(patch.id))}</p>{/if}
              <p class="hint">{$t(patch.descriptionKey)}</p>
              {#if patch.credits}<p class="hint">{$t('credit.line', { source: patch.credits.source })}</p>{/if}
              {#if patch.source}<p class="hint">{$t('review.fromPack', { pack: packName(patch.source), version: patch.source.packVersion })}</p>{/if}
            </details>
          </div>
        </Card>
      {:else}
        <Card class="patch off" muted aria-disabled="true">
          <input type="checkbox" class="chk" disabled checked={status === 'applied'} aria-label={`${$t(patch.nameKey)} (${$t(statusBadge(status))})`} />
          <div class="pb">
            <div class="pt">
              <span class="ptitle off-t">{$t(patch.nameKey)}</span>
              {#if patch.source}<Badge tone="sun">{$t('badge.pack')}</Badge>{/if}
              {#if status === 'applied'}<Badge tone="info" icon="check">{$t('badge.applied')}</Badge>
              {:else if status === 'outdated'}<Badge tone="warn" icon="ban">{$t('badge.updateBlocked')}</Badge>
              {:else}<Badge tone="bad" icon="ban">{$t('badge.notForVersion')}</Badge>{/if}
            </div>
            <p class="muted desc">{status === 'applied' ? $t('review.appliedNote') : status === 'outdated' ? $t('review.updateBlockedNote', { to: patchVersionText(patch, patch.version) }) : reasonCode ? describeReason($t, reasonCode) : reason}</p>
          </div>
        </Card>
      {/if}
    {/each}
  </section>
</div>

<style>
  .head { display: flex; flex-direction: column; gap: 8px; }
  h1 { font-size: 34px; }
  .lead { font-size: 17px; }
  .split { display: flex; flex-wrap: wrap; gap: 22px; align-items: flex-start; }
  .split :global(.info) { flex: 1 1 280px; max-width: 320px; display: flex; flex-direction: column; gap: 14px; }
  .patches { flex: 999 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  .ph { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .ph h2 { font-size: 22px; }
  .gh { display: flex; gap: 12px; align-items: center; }
  .gh h2 { font-size: 19px; }
  .gi { width: 52px; height: 52px; border-radius: 14px; background: var(--surface-2); border: 2px solid var(--line); display: grid; place-items: center; flex: none; }
  .kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 14px; font-size: 14.5px; margin: 0; }
  .kv dt { color: var(--text-3); font-weight: 700; }
  .kv dd { margin: 0; overflow-wrap: anywhere; }
  .sign { border-top: 2px solid var(--line); padding-top: 14px; display: flex; flex-direction: column; gap: 10px; }
  .sl { font-weight: 700; font-size: 14.5px; }
  .key { display: flex; gap: 10px; align-items: center; }
  .ki { width: 36px; height: 36px; border-radius: 10px; background: var(--sun); color: var(--on-sun); display: grid; place-items: center; flex: none; }
  .kt { min-width: 0; }
  .kn { font-weight: 700; font-size: 15px; }
  .sign :global(.chg) { align-self: flex-start; }
  .patches :global(.patch) { --card-pad: 18px 20px; display: flex; gap: 16px; align-items: flex-start; cursor: pointer; }
  .patches :global(.patch.off) { cursor: not-allowed; }
  .chk { width: 22px; height: 22px; accent-color: var(--primary); margin: 2px 0 0; flex: none; }
  .pb { display: flex; flex-direction: column; gap: 8px; flex: 1; min-width: 0; }
  .pt { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .ptitle { font-weight: 700; font-size: 17px; }
  .off-t { color: var(--text-2); }
  .desc { font-size: 15px; }
  .more summary { cursor: pointer; font-weight: 700; font-size: 14px; color: var(--primary-ink); list-style: none; min-height: 32px; display: inline-flex; align-items: center; gap: 6px; }
  .more summary::-webkit-details-marker { display: none; }
  .more[open] summary :global(.ico) { transform: rotate(180deg); }
  .more p { margin-top: 4px; max-width: 560px; }
  .more .when { font-weight: 700; }
</style>
