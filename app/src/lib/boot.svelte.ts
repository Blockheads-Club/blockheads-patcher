import { defaultRegistry } from '@bh-patcher/core';
import type { KeysState } from './keys.svelte';
import type { PacksState } from './packs.svelte';
import type { BootPhase } from './splash';

export type Phase = BootPhase | 'ready';

/** How long the boot may take before the splash says it is still working. */
export const SLOW_MS = 4000;

/**
 * The work the app needs before it can be used: the list of fixes, the signing key and the saved settings
 * (preferences and theme are read synchronously when the app starts) and the imported patch packs. A missing patch
 * list is fatal; an unreadable key store or pack store is not (the Keys screen reports it, patching creates a key on
 * demand, and packs can be imported again).
 */
export async function bootWork(keys: Pick<KeysState, 'refresh'>, packs?: Pick<PacksState, 'init'>): Promise<void> {
  if (defaultRegistry.list().length === 0) throw new Error('The list of fixes is empty');
  await keys.refresh().catch(() => {});
  await packs?.init().catch(() => {});
}

/** Boot progress for the splash: loading -> (slow) -> ready, or error with a way to retry. */
export class Boot {
  phase = $state<Phase>('loading');
  error = $state('');
  private seq = 0;

  constructor(private work: () => Promise<void>, private slowMs = SLOW_MS) {}

  async run(): Promise<void> {
    const seq = ++this.seq;
    this.phase = 'loading';
    this.error = '';
    const timer = setTimeout(() => { if (seq === this.seq && this.phase === 'loading') this.phase = 'slow'; }, this.slowMs);
    try {
      await this.work();
      if (seq === this.seq) this.phase = 'ready';
    } catch (e) {
      if (seq === this.seq) { this.error = e instanceof Error ? e.message : String(e); this.phase = 'error'; }
    } finally {
      clearTimeout(timer);
    }
  }
}
