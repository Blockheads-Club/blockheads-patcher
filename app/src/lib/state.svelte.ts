import type { Engine, LoadedApk, ApplicableReport, PatchApkResult } from './engine';
import type { PickedApk, PlatformAdapter } from './platform/types';

export type Stage = 'idle' | 'loaded' | 'patching' | 'done' | 'error';
export type ProgressStage = 'read' | 'parse' | 'patch' | 'write' | 'sign' | 'done';

const isCancelled = (e: unknown): boolean => e instanceof Error && e.name === 'CancelledError';
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export class PatcherState {
  stage = $state<Stage>('idle');
  loading = $state(false);
  picked = $state.raw<PickedApk | null>(null);
  loaded = $state.raw<LoadedApk | null>(null);
  report = $state.raw<ApplicableReport>([]);
  selected = $state<string[]>([]);
  progress = $state<{ stage: ProgressStage; fraction: number }>({ stage: 'read', fraction: 0 });
  result = $state.raw<PatchApkResult | null>(null);
  /** Raw thrown value; render with describeError() so it is translated. */
  error = $state.raw<unknown>(null);

  private abort: AbortController | null = null;

  constructor(readonly platform: PlatformAdapter, readonly engine: Engine) {}

  /** Wizard step 1..4 for the step indicator. */
  step = $derived(
    this.stage === 'idle' || (this.stage === 'error' && !this.loaded) ? 1 : this.stage === 'loaded' ? 2 : this.stage === 'patching' ? 3 : this.stage === 'done' ? 4 : 2
  );

  async load(p: PickedApk): Promise<void> {
    this.error = null;
    this.loading = true;
    try {
      await tick();
      await this.parse(p);
    } catch (e) {
      this.fail(e);
    } finally {
      this.loading = false;
    }
  }

  private async parse(p: PickedApk): Promise<void> {
    const loaded = await this.engine.loadApk(p.bytes);
    const report = this.engine.listPatches(loaded);
    this.picked = p;
    this.loaded = loaded;
    this.report = report;
    this.selected = report.filter((r) => r.status === 'notApplied').map((r) => r.patch.id);
    this.stage = 'loaded';
  }

  async run(): Promise<void> {
    const picked = this.picked, loaded = this.loaded;
    if (!picked || !loaded || this.selected.length === 0) return;
    this.error = null;
    this.stage = 'patching';
    this.progress = { stage: 'read', fraction: 0 };
    const abort = this.abort = new AbortController();
    try {
      await tick();
      // Reuse the already parsed archive (no second read/inflate); it is mutated, so drop it afterwards.
      this.result = await this.engine.patchLoaded(loaded, {
        patchIds: [...this.selected],
        signal: abort.signal,
        onProgress: (stage, fraction) => { this.progress = { stage, fraction }; }
      });
      this.loaded = null; this.picked = null; this.report = [];
      this.stage = 'done';
    } catch (e) {
      // The parsed archive may be half-patched: restore it (the worker keeps the input) or parse the original bytes again.
      try {
        if (this.engine.reload) {
          await this.engine.reload(loaded);
          this.report = this.engine.listPatches(loaded);
          this.stage = 'loaded';
        } else await this.parse(picked);
      } catch { this.loaded = null; }
      if (isCancelled(e)) this.stage = this.loaded ? 'loaded' : 'idle';
      else this.fail(e);
    } finally {
      this.abort = null;
    }
  }

  /** Cancels a running patch; the loaded APK stays available. */
  cancel(): void {
    this.abort?.abort();
  }

  back(): void {
    this.error = null;
    this.result = null;
    this.stage = this.loaded ? 'loaded' : 'idle';
  }

  reset(): void {
    if (this.loaded) this.engine.release?.(this.loaded);
    this.stage = 'idle';
    this.picked = null; this.loaded = null; this.report = []; this.selected = [];
    this.result = null; this.error = null;
  }

  private fail(e: unknown): void {
    this.error = e;
    this.stage = this.loaded ? 'error' : 'idle';
  }
}
