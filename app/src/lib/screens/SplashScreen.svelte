<script lang="ts">
  import logo from '$lib/assets/patcher-icon.svg';
  import { t } from '$lib/i18n';
  import type { BootPhase } from '$lib/splash';

  /**
   * The start-up card of the design. `card` is the 600x380 desktop/web card, `phone` the full-screen Android
   * layout (the system splash hands over to it, and it carries the error state).
   */
  let { phase, version = '', detail = '', variant = 'card', windowed = false, square = false, onretry, onopenlog, onquit }: {
    phase: BootPhase;
    version?: string;
    /** Technical error text; shown by "Open log" when the host cannot open a log file. */
    detail?: string;
    variant?: 'card' | 'phone';
    /** The card is the whole window (splash window): fills it, drags it, no drop shadow. */
    windowed?: boolean;
    /** No transparency (macOS): the window is the card, so no rounded corners. */
    square?: boolean;
    onretry: () => void;
    onopenlog?: () => void;
    onquit?: () => void;
  } = $props();

  const drag = $derived(windowed ? { 'data-tauri-drag-region': '' } : {});
</script>

{#if variant === 'phone'}
  <section class="ph bg" role="status" aria-live="polite" aria-label={$t('splash.label')}>
    <div class="disc ic"><img src={logo} alt="" width="118" height="118" /></div>
    {#if phase === 'error'}
      <div class="perr" role="alert">
        <p>{$t('splash.errorShort')}</p>
        <button class="btn b1 tall" onclick={() => onretry()}>{$t('splash.retry')}</button>
      </div>
    {:else}
      <p class="sr-only">{phase === 'slow' ? $t('splash.slow') : $t('splash.loading')}</p>
    {/if}
    <div class="pwm"><div class="wm small">Blockheads<span class="tg">Patcher</span></div></div>
  </section>
{:else}
  <section class={['sp', 'bg', { windowed, square }]} role="status" aria-live="polite" aria-label={$t('splash.label')} {...drag}>
    <img class="ic icon" src={logo} alt="" width="120" height="120" {...drag} />
    <div class="wm" {...drag}>Blockheads<span class="tg" {...drag}>Patcher</span></div>
    {#if phase === 'error'}
      <p class="msg err" role="alert" {...drag}>{$t('splash.error')}</p>
      {#if detail}<p class="detail" {...drag}>{detail}</p>{/if}
      <div class="acts">
        <button class="btn b1" onclick={() => onretry()}>{$t('splash.retry')}</button>
        {#if onopenlog}<button class="btn b2" onclick={() => onopenlog()}>{$t('splash.openLog')}</button>{/if}
        {#if onquit}<button class="btn b3" onclick={() => onquit()}>{$t('splash.quit')}</button>{/if}
      </div>
    {:else}
      <div class="bar" {...drag}><span {...drag}></span></div>
      <p class="msg" {...drag}>{phase === 'slow' ? $t('splash.slow') : $t('splash.loading')}</p>
    {/if}
    <div class="foot" {...drag}><span {...drag}>{$t('splash.footer')}</span>{#if version}<span class="mono" {...drag}>{version}</span>{/if}</div>
  </section>
{/if}

<style>
  .bg { background-color: #c2410c; background-image: repeating-conic-gradient(from -3deg at 50% 118%, rgba(255, 242, 192, 0.16) 0deg 7deg, transparent 7deg 22deg); color: #fff; }
  .sp {
    width: 600px; max-width: calc(100vw - 32px); height: 380px; border-radius: 18px; overflow: hidden; position: relative;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; text-align: center;
    padding: 24px 24px 48px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.25);
  }
  .sp.windowed { width: 100vw; max-width: none; height: 100vh; box-shadow: none; }
  .sp.square { border-radius: 0; }
  .icon { width: 120px; height: 120px; border-radius: 28px; box-shadow: 0 8px 0 #7a2a08; }
  .ic { animation: drop 0.6s cubic-bezier(0.2, 0.9, 0.3, 1.2) both; }
  @keyframes drop { from { transform: translateY(-28px) rotate(-10deg); opacity: 0; } to { transform: translateY(0) rotate(-4deg); opacity: 1; } }
  .wm { display: flex; align-items: center; gap: 8px; font: 800 30px/1 var(--f-display); letter-spacing: -0.02em; }
  .wm.small { font-size: 20px; }
  .tg { display: inline-block; padding: 3px 8px 4px; border-radius: 7px; transform: rotate(-6deg); font-size: 24px; background: #ffd27a; color: #1f1a17; box-shadow: 0 3px 0 #7a2a08; }
  .small .tg { font-size: 16px; }
  .bar { width: 260px; max-width: 100%; height: 8px; border-radius: 999px; overflow: hidden; position: relative; margin-top: 6px; background: rgba(255, 255, 255, 0.25); }
  .bar span { position: absolute; top: 0; bottom: 0; width: 35%; border-radius: 999px; background: #ffd27a; animation: slide 1.3s ease-in-out infinite; }
  @keyframes slide { from { left: -35%; } to { left: 100%; } }
  .msg { font-size: 14.5px; color: #ffe3d2; }
  .err { font-size: 15px; font-weight: 700; max-width: 440px; color: #fff; }
  .detail { font: 12.5px/1.4 var(--f-mono); color: #ffe3d2; max-width: 440px; overflow-wrap: anywhere; }
  .acts { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .foot { position: absolute; left: 18px; right: 18px; bottom: 14px; display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; color: #ffe3d2; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 0 14px; border-radius: 10px; font: 700 14px var(--f-body); cursor: pointer; }
  .btn.tall { min-height: 44px; }
  .b1 { background: #ffd27a; color: #1f1a17; border: 2px solid #1f1a17; box-shadow: 0 3px 0 #7a2a08; }
  .b2 { background: rgba(31, 26, 23, 0.25); color: #fff; border: 2px solid rgba(255, 255, 255, 0.45); }
  .b3 { background: transparent; color: #ffe3d2; border: 2px solid transparent; }
  .btn:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }

  .ph { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 24px; }
  .disc { width: 168px; height: 168px; border-radius: 50%; background: #ffd27a; display: grid; place-items: center; box-shadow: 0 6px 0 #7a2a08; }
  .disc img { width: 118px; height: 118px; border-radius: 26px; }
  .perr { position: absolute; left: 20px; right: 20px; bottom: 110px; display: flex; flex-direction: column; gap: 10px; align-items: center; }
  .perr p { font-weight: 700; font-size: 15px; }
  .pwm { position: absolute; bottom: calc(40px + env(safe-area-inset-bottom)); left: 0; right: 0; display: flex; justify-content: center; }

  @media (prefers-reduced-motion: reduce) {
    .ic, .bar span { animation: none; }
    .bar span { left: 0; width: 100%; opacity: 0.6; }
  }
</style>
