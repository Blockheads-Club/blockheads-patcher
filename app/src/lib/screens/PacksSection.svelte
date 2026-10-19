<script lang="ts">
  import { t, lang } from '$lib/i18n';
  import type { PacksState } from '$lib/packs.svelte';
  import type { PickedFile, PlatformAdapter } from '$lib/platform/types';
  import Button from '$lib/ui/Button.svelte';
  import Callout from '$lib/ui/Callout.svelte';
  import Card from '$lib/ui/Card.svelte';

  let { packs, platform }: { packs: PacksState; platform: PlatformAdapter } = $props();

  let over = $state(false);
  let status = $state('');
  let input: HTMLInputElement | undefined = $state();
  const web = $derived(platform.kind === 'web');
  const localized = (m: Record<string, string> & { en: string }) => m[$lang] ?? m.en;
  const isPack = (name: string) => /\.(bhpack|zip)$/i.test(name);

  async function importFiles(files: PickedFile[]) {
    status = '';
    for (const f of files) {
      if (await packs.import(f.name, f.bytes)) status = $t('packs.imported', { name: f.name });
    }
  }
  async function browse() {
    if (!platform.pickPack) { input?.click(); return; }
    const f = await platform.pickPack();
    if (f) await importFiles([f]);
  }
  async function fromFileList(list: FileList | null | undefined) {
    const files = await Promise.all([...(list ?? [])].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    await importFiles(files);
  }
  function ondrop(e: DragEvent) {
    e.preventDefault();
    over = false;
    void fromFileList(e.dataTransfer?.files);
  }

  // Desktop: the webview gets no DOM drop events, the shell reports dropped paths instead.
  $effect(() => {
    if (!platform.onFileDrop) return;
    let off: (() => void) | undefined;
    let gone = false;
    platform.onFileDrop((files) => void importFiles(files.filter((f) => isPack(f.name))))
      .then((u) => (gone ? u() : (off = u)), () => {});
    return () => { gone = true; off?.(); };
  });

  const nameOf = (id: string) => $t(`patch.${id}.name`);
</script>

<input bind:this={input} type="file" accept=".bhpack,.zip,application/zip" hidden data-testid="pack-input"
  onchange={(e) => { const l = e.currentTarget.files; void fromFileList(l).then(() => { if (input) input.value = ''; }); }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<Card tag="section" class={over ? 'grp packs over' : 'grp packs'} aria-labelledby="s-k"
  ondragover={web ? (e: DragEvent) => { e.preventDefault(); over = true; } : undefined}
  ondragleave={web ? () => (over = false) : undefined}
  ondrop={web ? ondrop : undefined}>
  <h2 id="s-k">{$t('packs.title')}</h2>
  <div class="row col">
    <p class="hint">{$t('packs.hint')}</p>
    <Callout tone="warn" title={$t('packs.warnTitle')}>{$t('packs.warnBody')}</Callout>
  </div>
  <div class="row">
    <p class="hint">{platform.onFileDrop || web ? $t('packs.drop') : $t('packs.pickOnly')}</p>
    <Button size="sm" icon="plus" loading={packs.busy} disabled={packs.busy} onclick={browse}>{$t('packs.import')}</Button>
  </div>
  <p class="sr" role="status">{status}</p>

  {#if packs.problem}
    <div class="row col">
      <Callout tone="bad" role="alert" title={$t('packs.invalidTitle', { name: packs.problem.name })}>
        {#each packs.problem.issues.slice(0, 5) as i, n (n)}<span class="issue selectable">{i.message}</span>{/each}
        {#if packs.problem.issues.length > 5}<span class="issue">{$t('packs.moreIssues', { n: packs.problem.issues.length - 5 })}</span>{/if}
      </Callout>
    </div>
  {/if}

  {#each packs.broken as b (b.id)}
    <div class="row">
      <div class="rl"><p class="rt">{$t('packs.brokenTitle', { name: b.name })}</p><p class="hint selectable">{b.issues[0]?.message}</p></div>
      <Button size="sm" variant="quiet-danger" icon="trash" iconOnly onclick={() => packs.remove(b.id)}>{$t('packs.remove', { name: b.name })}</Button>
    </div>
  {/each}

  {#if packs.items.length === 0 && packs.broken.length === 0}
    <div class="row"><p class="hint">{$t('packs.empty')}</p></div>
  {/if}
  {#each packs.items as { pack } (pack.id)}
    <div class="row" data-testid="pack-row">
      <div class="rl">
        <p class="rt">{localized(pack.name)}</p>
        <p class="hint">
          {pack.author ? $t('packs.meta', { version: pack.version, author: pack.author }) : $t('packs.metaNoAuthor', { version: pack.version })}
          · {pack.patches.length === 1 ? $t('packs.countOne') : $t('packs.countMany', { n: pack.patches.length })}
        </p>
        {#if pack.description}<p class="hint">{localized(pack.description)}</p>{/if}
      </div>
      <Button size="sm" variant="quiet-danger" icon="trash" iconOnly onclick={() => packs.remove(pack.id)}>{$t('packs.remove', { name: localized(pack.name) })}</Button>
    </div>
  {/each}

  {#if packs.conflicts.length}
    <div class="row col">
      <Callout tone="info" title={$t('packs.conflictsTitle')}>
        {#each packs.conflicts as c (c.a + c.b)}<span class="issue">{$t('packs.conflict', { a: nameOf(c.a), b: nameOf(c.b), on: c.on })}</span>{/each}
      </Callout>
    </div>
  {/if}
</Card>

<style>
  h2 { font-size: 19px; padding: 16px 0 6px; }
  :global(.packs.over) { outline: 3px dashed var(--primary); outline-offset: 2px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 0; border-top: 1px solid var(--line); flex-wrap: wrap; }
  h2 + .row { border-top: 0; }
  .row.col { flex-direction: column; align-items: stretch; gap: 10px; }
  .rl { flex: 1 1 260px; min-width: 0; }
  .rt { font-weight: 700; overflow-wrap: anywhere; }
  .issue { display: block; overflow-wrap: anywhere; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
