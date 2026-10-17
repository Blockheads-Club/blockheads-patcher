<script lang="ts">
  import { t } from '$lib/i18n';
  import { describeError } from '$lib/errors';
  import { certFingerprint, type Engine } from '$lib/engine';
  import type { PlatformAdapter } from '$lib/platform/types';

  let { engine, platform }: { engine: Engine; platform: PlatformAdapter } = $props();

  let fingerprint = $state<string | null>(null);
  let note = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
  let input: HTMLInputElement | undefined = $state();
  let passphrase = $state('');

  async function refresh() {
    const id = await engine.keystore.get();
    fingerprint = id ? await certFingerprint(id.certificateDer) : null;
  }
  $effect(() => { refresh().catch(() => (fingerprint = null)); });

  const fail = (e: unknown) => { note = { kind: 'error', text: describeError($t, e) }; };

  async function regenerate() {
    if (fingerprint && !confirm($t('keys.regenerateConfirm'))) return;
    try {
      await engine.keystore.set(await engine.generateIdentity());
      await refresh();
      note = { kind: 'ok', text: $t('keys.generated') };
    } catch (e) { fail(e); }
  }
  async function exportKey() {
    try {
      let id = await engine.keystore.get();
      if (!id) { id = await engine.getOrCreateIdentity(); await refresh(); }
      const json = passphrase ? await engine.exportIdentityEncryptedJson(id, passphrase) : await engine.exportIdentityJson(id);
      await platform.saveOutput('blockheads-patcher-key.json', new TextEncoder().encode(json));
      note = { kind: 'ok', text: $t('keys.exported') };
    } catch (e) { fail(e); }
  }
  async function importKey(file: File | undefined) {
    if (!file) return;
    try {
      const text = await file.text();
      if (!passphrase && /"version"\s*:\s*2\b/.test(text)) {
        note = { kind: 'error', text: $t('keys.passphraseNeeded') };
        return;
      }
      await engine.keystore.set(await engine.importIdentity(text, passphrase || undefined));
      await refresh();
      note = { kind: 'ok', text: $t('keys.imported') };
    } catch (e) {
      note = { kind: 'error', text: $t('keys.importError', { message: e instanceof Error ? e.message : String(e) }) };
    }
  }
</script>

<section aria-labelledby="keys-title">
  <h2 id="keys-title">{$t('keys.title')}</h2>
  <p>{$t('keys.why')}</p>
  {#if fingerprint}
    <p><strong>{$t('keys.fingerprint')}</strong><br /><code class="fp" data-testid="fingerprint">{fingerprint}</code></p>
  {:else}
    <p class="muted">{$t('keys.none')}</p>
  {/if}
  <p class="warn" role="note">{$t('keys.secretWarning')}</p>
  <label class="pass">
    <span>{$t('keys.passphrase')}</span>
    <input type="password" autocomplete="off" bind:value={passphrase} data-testid="key-passphrase" />
  </label>
  <div class="row">
    <button type="button" onclick={exportKey}>{$t('keys.export')}</button>
    <button type="button" onclick={() => input?.click()}>{$t('keys.import')}</button>
    <button type="button" class="danger" onclick={regenerate}>{$t('keys.regenerate')}</button>
    <input bind:this={input} type="file" accept=".json,application/json" hidden data-testid="key-input"
      onchange={(e) => { importKey(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
  </div>
  {#if note}<p role={note.kind === 'error' ? 'alert' : 'status'} class={note.kind === 'error' ? 'error' : 'ok'}>{note.text}</p>{/if}
</section>

<style>
  .fp { word-break: break-all; font-size: 0.8rem; }
  .row { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .warn { border: 1px solid var(--warn-border); background: var(--warn-bg); border-radius: 10px; padding: 0.5rem 0.75rem; }
  .pass { display: grid; gap: 0.25rem; margin: 0.5rem 0; max-width: 24rem; }
</style>
