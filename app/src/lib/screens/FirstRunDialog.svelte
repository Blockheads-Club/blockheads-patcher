<script lang="ts">
  import { t } from '$lib/i18n';
  import { LEGAL_URL } from '$lib/links';
  import logo from '$lib/assets/patcher-icon-macos.svg';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import LanguageSelect from '$lib/ui/LanguageSelect.svelte';

  /** First run: consent to the legal points. `review` re-opens it read-only from Settings. */
  let { review = false, quitHint = false, onaccept, onquit, onclose }: { review?: boolean; quitHint?: boolean; onaccept?: () => void; onquit?: () => void; onclose?: () => void } = $props();

  let agreed = $state(false);
  const points = [
    { id: 'p1', icon: 'users', style: 'sun' },
    { id: 'p2', icon: 'file', style: 'primary' },
    { id: 'p3', icon: 'shield', style: 'info' },
    { id: 'p4', icon: 'alert', style: 'warn' }
  ] as const;
</script>

<Dialog labelledby="fr-t" describedby="fr-d" onclose={review ? onclose : undefined}>
  <div class="top">
    <img src={logo} alt="" width="56" height="56" />
    <LanguageSelect id="fr-lang" iconLeft />
  </div>
  <div class="intro"><h1 id="fr-t">{$t('firstrun.title')}</h1><p id="fr-d" class="muted">{$t('firstrun.lead')}</p></div>
  <div class="pts">
    {#each points as p (p.id)}
      <div class="pt">
        <span class={['pi', p.style]}><Icon name={p.icon} /></span>
        <div><p class="ptt">{$t(`firstrun.${p.id}.title`)}</p><p class="muted ptb">{$t(`firstrun.${p.id}.body`)}</p></div>
      </div>
    {/each}
  </div>
  {#if !review}
    <div class="agree"><label><input type="checkbox" class="chk" bind:checked={agreed} />{$t('firstrun.agree')}</label></div>
  {/if}
  <div class="foot">
    <a class="full" href={LEGAL_URL} target="_blank" rel="noopener noreferrer">{$t('firstrun.full')}</a>
    <div class="btns">
      {#if review}
        <Button variant="primary" size="lg" onclick={onclose} data-autofocus>{$t('firstrun.close')}</Button>
      {:else}
        <Button onclick={onquit}>{$t('firstrun.quit')}</Button>
        <Button variant="primary" size="lg" disabled={!agreed} onclick={onaccept} aria-describedby={agreed ? undefined : 'fr-why'}>{$t('firstrun.continue')}</Button>
      {/if}
    </div>
  </div>
  {#if !review && !agreed}<p id="fr-why" class="hint why">{$t('firstrun.tick')}</p>{/if}
  {#if quitHint}<p class="hint why" role="status">{$t('firstrun.quitHint')}</p>{/if}
</Dialog>

<style>
  .top { padding: 24px 28px 0; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .top img { border-radius: 13px; transform: rotate(-6deg); box-shadow: 0 4px 0 var(--logo-edge); }
  .intro { padding: 16px 28px 8px; display: flex; flex-direction: column; gap: 8px; }
  h1 { font-size: 30px; }
  .intro p { font-size: 16.5px; }
  .pts { padding: 0 28px; }
  .pt { display: flex; gap: 14px; align-items: flex-start; padding: 12px 0; border-bottom: 1px solid var(--line); }
  .pt:last-child { border-bottom: 0; }
  .pi { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; flex: none; }
  .pi.sun { background: var(--sun); color: var(--on-sun); }
  .pi.primary { background: var(--primary-soft); color: var(--primary-ink); }
  .pi.info { background: var(--info-soft); color: var(--info); }
  .pi.warn { background: var(--warn-soft); color: var(--warn); }
  .ptt { font-weight: 700; }
  .ptb { font-size: 15px; }
  .agree { margin: 8px 28px 0; padding: 14px 16px; border-radius: 12px; background: var(--surface-2); }
  .agree label { display: flex; gap: 12px; align-items: flex-start; cursor: pointer; font-weight: 700; font-size: 15.5px; }
  .chk { width: 22px; height: 22px; accent-color: var(--primary); margin: 1px 0 0; flex: none; }
  .foot { padding: 20px 28px 24px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .full { font-weight: 700; font-size: 15px; }
  .btns { display: flex; gap: 10px; flex-wrap: wrap; }
  .why { padding: 0 28px 20px; margin-top: -10px; }
</style>
