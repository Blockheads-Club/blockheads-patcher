<script lang="ts">
  let { checked = $bindable(false), label, hint, id }: { checked?: boolean; label: string; hint?: string; id: string } = $props();
</script>

<div class="row">
  <div class="text"><p id={`${id}-l`} class="label">{label}</p>{#if hint}<p class="hint" id={`${id}-h`}>{hint}</p>{/if}</div>
  <label class="sw">
    <input type="checkbox" role="switch" {id} bind:checked aria-labelledby={`${id}-l`} aria-describedby={hint ? `${id}-h` : undefined} />
    <span class="track" aria-hidden="true"></span>
  </label>
</div>

<style>
  .row { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
  .text { flex: 1 1 260px; min-width: 0; }
  .label { font-weight: 700; }
  .sw { display: inline-flex; position: relative; cursor: pointer; min-height: 44px; align-items: center; }
  input { position: absolute; opacity: 0; width: 46px; height: 28px; margin: 0; cursor: pointer; }
  .track { width: 46px; height: 28px; border-radius: 999px; background: var(--surface-3); border: 2px solid var(--line-strong); position: relative; flex: none; transition: background-color var(--dur-fast); }
  .track::after { content: ''; position: absolute; top: 3px; inset-inline-start: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--text-3); transition: transform var(--dur-press); }
  input:checked + .track { background: var(--primary); border-color: var(--primary-edge); }
  input:checked + .track::after { transform: translateX(18px); background: var(--on-primary); }
  input:focus-visible + .track { outline: 3px solid var(--focus); outline-offset: 2px; }
</style>
