<script lang="ts">
  import { t, lang } from '$lib/i18n';
  import { describeError } from '$lib/errors';
  import { formatDate } from '$lib/format';
  import { copyText } from '$lib/clipboard';
  import type { PlatformAdapter } from '$lib/platform/types';
  import type { KeysState, KeyView } from '$lib/keys.svelte';
  import Blob from '$lib/ui/Blob.svelte';
  import Badge from '$lib/ui/Badge.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Callout from '$lib/ui/Callout.svelte';
  import Card from '$lib/ui/Card.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Fingerprint from '$lib/ui/Fingerprint.svelte';
  import Icon from '$lib/ui/Icon.svelte';

  let { keys, platform, onback }: { keys: KeysState; platform: PlatformAdapter; onback: () => void } = $props();

  let input: HTMLInputElement | undefined = $state();
  let note = $state<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  let renaming = $state<string | null>(null);
  let nameDraft = $state('');
  let exporting = $state<string | null>(null);
  let pw1 = $state('');
  let pw2 = $state('');
  let deleting = $state<KeyView | null>(null);
  let pendingImport = $state<string | null>(null);
  let importPw = $state('');
  let copied = $state<string | null>(null);

  $effect(() => { keys.refresh().catch(() => {}); });

  const display = (k: KeyView) => k.name || $t('keys.defaultName');
  const nextName = () => (keys.keys.length === 0 ? $t('keys.defaultName') : $t('keys.newName', { n: keys.keys.length + 1 }));
  const fail = (e: unknown) => { note = { tone: 'bad', text: describeError($t, e) }; };
  const ok = (text: string) => { note = { tone: 'ok', text }; };
  const activeKey = $derived(keys.keys.find((k) => k.active));
  const others = $derived(keys.keys.filter((k) => !k.active));
  const mismatch = $derived(pw1 !== pw2);

  async function generate() {
    note = null;
    try { await keys.generate(nextName()); ok($t('keys.generated')); } catch (e) { fail(e); }
  }
  async function pickFile(file: File | undefined) {
    if (!file) return;
    note = null;
    try {
      const text = await file.text();
      if (/"version"\s*:\s*2\b/.test(text)) { pendingImport = text; importPw = ''; return; }
      await doImport(text, undefined);
    } catch (e) { note = { tone: 'bad', text: $t('keys.importError', { message: e instanceof Error ? e.message : String(e) }) }; }
  }
  async function doImport(text: string, pw: string | undefined) {
    try { await keys.import(text, pw, nextName()); pendingImport = null; ok($t('keys.imported')); }
    catch (e) { pendingImport = null; note = { tone: 'bad', text: $t('keys.importError', { message: e instanceof Error ? e.message : String(e) }) }; }
  }
  async function saveRename(id: string) {
    try { await keys.rename(id, nameDraft.trim()); renaming = null; } catch (e) { fail(e); }
  }
  async function doExport(id: string) {
    if (mismatch) return;
    try {
      const json = await keys.exportJson(id, pw1);
      await platform.saveOutput('blockheads-patcher-key.json', new TextEncoder().encode(json));
      exporting = null; pw1 = pw2 = '';
      ok($t('keys.exported'));
    } catch (e) { fail(e); }
  }
  async function doDelete(k: KeyView) {
    deleting = null;
    try { await keys.remove(k.id); } catch (e) { fail(e); }
  }
  async function copyFp(k: KeyView) {
    if (await copyText(k.fingerprint)) { copied = k.id; setTimeout(() => (copied = null), 2000); }
  }
</script>

{#snippet title(k: KeyView, big: boolean)}
  {#if renaming === k.id}
    <form class="rn" onsubmit={(e) => { e.preventDefault(); void saveRename(k.id); }}>
      <label class="sr-only" for={`rn-${k.id}`}>{$t('keys.nameLabel')}</label>
      <input id={`rn-${k.id}`} class="inp" bind:value={nameDraft} data-autofocus />
      <Button size="sm" variant="primary" type="submit">{$t('keys.save')}</Button>
      <Button size="sm" onclick={() => (renaming = null)}>{$t('action.cancel')}</Button>
    </form>
  {:else}
    <div class="nm">
      {#if big}<h2 id={`k-${k.id}`}>{display(k)}</h2>{:else}<h2 id={`k-${k.id}`} class="small">{display(k)}</h2>{/if}
      {#if k.active}<Badge tone="ok" icon="check">{$t('keys.inUse')}</Badge>{/if}
    </div>
  {/if}
{/snippet}

<Button variant="ghost" icon="chev-l" class="back" onclick={onback}>{$t('nav.back')}</Button>

<div class="head">
  <div class="ht"><h1>{$t('keys.title')}</h1><p class="muted">{$t('keys.lead')}</p></div>
  <div class="acts">
    <Button icon="upload" onclick={() => input?.click()}>{$t('keys.import')}</Button>
    <Button variant="primary" icon="plus" onclick={generate}>{$t('keys.generate')}</Button>
  </div>
</div>
<input bind:this={input} type="file" accept=".json,application/json" hidden data-testid="key-input"
  onchange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void pickFile(f); }} />

{#if note}<Callout tone={note.tone} role={note.tone === 'bad' ? 'alert' : 'status'}>{note.text}</Callout>{/if}

<div class="split">
  <div class="main">
    {#if keys.ready && keys.keys.length === 0}
      <Card class="none">
        <Blob icon="key" tone="sun" />
        <h2>{$t('keys.noneTitle')}</h2>
        <p class="muted nb">{$t('keys.noneBody')}</p>
        <div class="acts c">
          <Button variant="primary" icon="plus" onclick={generate}>{$t('keys.generate')}</Button>
          <Button icon="upload" onclick={() => input?.click()}>{$t('keys.import')}</Button>
        </div>
        <p class="hint">{$t('keys.noneHint')}</p>
      </Card>
    {/if}

    {#if activeKey}
      {@const k = activeKey}
      <Card tag="section" selected class="kc" aria-labelledby={`k-${k.id}`}>
        <div class="kh">
          <span class="kicon"><Icon name="key" size={24} /></span>
          <div class="kt">{@render title(k, true)}<p class="hint">{$t('keys.added', { date: formatDate(k.addedAt, $lang) })}</p></div>
          {#if renaming !== k.id}<Button variant="ghost" size="sm" iconOnly icon="edit" onclick={() => { renaming = k.id; nameDraft = k.name; }}>{$t('keys.rename', { name: display(k) })}</Button>{/if}
        </div>
        <div class="fpb">
          <div class="fph"><p class="fl" id={`fp-${k.id}`}>{$t('keys.fingerprint')}</p>
            <Button size="sm" icon={copied === k.id ? 'check' : 'copy'} onclick={() => copyFp(k)}>{copied === k.id ? $t('action.copied') : $t('action.copy')}</Button></div>
          <Fingerprint pairs={k.pairs} labelledby={`fp-${k.id}`} />
          <p class="hint">{$t('keys.compare')}</p>
        </div>
        <div class="ka">
          <Button variant="primary" icon="download" onclick={() => { exporting = k.id; pw1 = pw2 = ''; }}>{$t('keys.export')}</Button>
          <Button variant="quiet-danger" icon="trash" class="del" onclick={() => (deleting = k)}>{$t('keys.delete')}</Button>
        </div>
      </Card>
    {/if}

    {#each others as k (k.id)}
      <Card tag="section" class="kc small" aria-labelledby={`k-${k.id}`}>
        <div class="kh">
          <span class="kicon off"><Icon name="key" /></span>
          <div class="kt">{@render title(k, false)}<p class="hint mono fps">{k.pairs.slice(0, 3).join(':')}:…:{k.pairs.slice(-2).join(':')} · {$t('keys.added', { date: formatDate(k.addedAt, $lang) })}</p></div>
          <div class="kb">
            {#if renaming !== k.id}<Button variant="ghost" size="sm" iconOnly icon="edit" onclick={() => { renaming = k.id; nameDraft = k.name; }}>{$t('keys.rename', { name: display(k) })}</Button>{/if}
            <Button variant="ghost" size="sm" iconOnly icon="download" onclick={() => { exporting = k.id; pw1 = pw2 = ''; }}>{$t('keys.export')}</Button>
            <Button variant="quiet-danger" size="sm" iconOnly icon="trash" onclick={() => (deleting = k)}>{$t('keys.delete')}</Button>
            <Button size="sm" onclick={() => keys.use(k.id).catch(fail)}>{$t('keys.use')}</Button>
          </div>
        </div>
      </Card>
    {/each}

    {#if exporting}
      {@const id = exporting}
      <Card tag="form" muted class="exp" aria-labelledby="ex-t" onsubmit={(e: Event) => { e.preventDefault(); void doExport(id); }}>
        <p id="ex-t" class="et"><Icon name="lock" />{$t('keys.exportTitle')}</p>
        <div class="pws">
          <div><label class="lbl" for="pw1">{$t('keys.password')}</label><input id="pw1" class="inp" type="password" autocomplete="new-password" bind:value={pw1} data-testid="key-passphrase" /></div>
          <div><label class="lbl" for="pw2">{$t('keys.repeat')}</label><input id="pw2" class="inp" type="password" autocomplete="new-password" bind:value={pw2} aria-invalid={mismatch} aria-describedby={mismatch ? 'pw-err' : undefined} /></div>
        </div>
        {#if mismatch}<p id="pw-err" class="perr"><Icon name="alert" size={16} />{$t('keys.mismatch')}</p>{/if}
        <p class="hint">{$t('keys.pwHint')}</p>
        <div class="row"><Button variant="primary" icon="download" type="submit" disabled={mismatch}>{$t('keys.exportSave')}</Button><Button onclick={() => (exporting = null)}>{$t('action.cancel')}</Button></div>
      </Card>
    {/if}
  </div>

  <aside class="aside">
    <section class="why" aria-labelledby="why">
      <h2 id="why">{$t('keys.whyTitle')}</h2>
      <div class="wy"><Icon name="refresh" class="wi" /><p><strong>{$t('keys.why1.title')}</strong> {$t('keys.why1.body')}</p></div>
      <div class="wy"><Icon name="alert" class="wi" /><p><strong>{$t('keys.why2.title')}</strong> {$t('keys.why2.body')}</p></div>
      <div class="wy"><Icon name="lock" class="wi" /><p><strong>{$t('keys.why3.title')}</strong> {$t('keys.why3.body')}</p></div>
    </section>
    <p class="hint">{$t('keys.formats')}</p>
  </aside>
</div>

{#if deleting}
  {@const k = deleting}
  <Dialog labelledby="del-t" onclose={() => (deleting = null)}>
    <div class="dlg">
      <div class="dh"><span class="di"><Icon name="trash" /></span>
        <div><h2 id="del-t">{$t('keys.deleteTitle', { name: display(k) })}</h2><p class="muted">{$t('keys.deleteBody')}</p></div></div>
      <div class="dact"><Button data-autofocus onclick={() => (deleting = null)}>{$t('action.cancel')}</Button><Button variant="danger" onclick={() => doDelete(k)}>{$t('keys.delete')}</Button></div>
    </div>
  </Dialog>
{/if}

{#if pendingImport}
  {@const text = pendingImport}
  <Dialog labelledby="imp-t" onclose={() => (pendingImport = null)}>
    <form class="dlg" onsubmit={(e) => { e.preventDefault(); void doImport(text, importPw); }}>
      <div><h2 id="imp-t">{$t('keys.importTitle')}</h2><p class="muted">{$t('keys.importBody')}</p></div>
      <div><label class="lbl" for="imp-pw">{$t('keys.password')}</label><input id="imp-pw" class="inp" type="password" autocomplete="off" bind:value={importPw} data-autofocus data-testid="import-passphrase" /></div>
      <div class="dact"><Button onclick={() => (pendingImport = null)}>{$t('action.cancel')}</Button><Button variant="primary" type="submit">{$t('keys.importGo')}</Button></div>
    </form>
  </Dialog>
{/if}

<style>
  :global(.back) { align-self: flex-start; --btn-px: 4px; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
  .ht { display: flex; flex-direction: column; gap: 6px; }
  h1 { font-size: 34px; }
  .ht p { font-size: 17px; }
  .acts { display: flex; gap: 10px; flex-wrap: wrap; }
  .acts.c { justify-content: center; }
  .split { display: flex; flex-wrap: wrap; gap: 22px; align-items: flex-start; }
  .main { flex: 999 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
  .aside { flex: 1 1 280px; max-width: 340px; display: flex; flex-direction: column; gap: 16px; }
  :global(.none) { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 14px; --card-pad: 40px 24px; }
  :global(.none) h2 { font-size: 24px; }
  .nb { max-width: 460px; }
  :global(.kc) { display: flex; flex-direction: column; gap: 14px; --card-pad: 20px 22px; }
  :global(.kc.small) { --card-pad: 16px 22px; }
  .kh { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  .kicon { width: 48px; height: 48px; border-radius: 13px; background: var(--sun); color: var(--on-sun); display: grid; place-items: center; transform: rotate(-6deg); box-shadow: 0 3px 0 var(--sun-edge); flex: none; }
  .kicon.off { width: 40px; height: 40px; border-radius: 11px; background: var(--surface-2); color: var(--text-2); transform: none; box-shadow: none; }
  .kt { flex: 1; min-width: 200px; }
  .nm { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .nm h2 { font-size: 20px; }
  .nm h2.small { font-size: 17px; }
  .fps { font-size: 13px; overflow-wrap: anywhere; }
  .kb { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .fpb { display: flex; flex-direction: column; gap: 6px; }
  .fph { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .fl { font-weight: 700; font-size: 14.5px; }
  .ka { display: flex; gap: 10px; flex-wrap: wrap; border-top: 2px solid var(--line); padding-top: 14px; }
  .ka :global(.del) { margin-inline-start: auto; }
  .rn { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .inp { width: 100%; min-height: 44px; padding: 0 14px; border: 2px solid var(--line-strong); border-radius: var(--r-md); background: var(--surface); color: var(--text); font: 16px/1.4 var(--f-body); }
  .rn .inp { width: auto; flex: 1 1 160px; }
  .inp[aria-invalid='true'] { border-color: var(--bad); }
  .lbl { display: block; font-weight: 700; font-size: 14.5px; margin-bottom: 6px; }
  :global(.exp) { display: flex; flex-direction: column; gap: 12px; --card-pad: 16px 22px; }
  .et { font-weight: 700; display: flex; gap: 8px; align-items: center; }
  .pws { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 12px; }
  .perr { color: var(--bad); font-size: 13.5px; font-weight: 700; display: flex; gap: 6px; align-items: center; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  .why { padding: 20px; display: flex; flex-direction: column; gap: 14px; background: var(--sun); border: 2px solid #e9b95e; border-radius: var(--r-lg); color: var(--on-sun); }
  .why h2 { font-size: 20px; }
  .wy { display: flex; gap: 12px; align-items: flex-start; font-size: 15px; }
  .wy :global(.wi) { margin-top: 2px; }
  .dlg { padding: 24px; display: flex; flex-direction: column; gap: 14px; }
  .dh { display: flex; gap: 14px; align-items: flex-start; }
  .di { width: 44px; height: 44px; border-radius: 12px; background: var(--bad-soft); color: var(--bad); display: grid; place-items: center; flex: none; }
  .dlg h2 { font-size: 20px; margin-bottom: 6px; }
  .dact { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
</style>
