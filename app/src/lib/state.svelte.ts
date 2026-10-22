import type { Engine, LoadedApk, ApplicableReport, PatchApkResult } from './engine';
import { GAME_PACKAGE, type PickedApk, type PlatformAdapter } from './platform/types';
import { formatBytes } from './format';
import { fetchModLoader } from './modloader';

export type Stage = 'idle' | 'loaded' | 'patching' | 'done' | 'error';
export type ProgressStage = 'read' | 'parse' | 'patch' | 'write' | 'sign' | 'done';
export interface LogLine { time: Date; kind: string; text: string; }
/** Why the chosen file cannot be patched at all (no patch applies). Shown on the Choose step. */
export interface Unsupported {
  name: string; packageName: string; versionName?: string; versionCode?: number;
  wrongPackage: boolean; reason?: { code: string; params: Record<string, string | number> };
}

const isCancelled = (e: unknown): boolean => e instanceof Error && e.name === 'CancelledError';
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class PatcherState {
  stage = $state<Stage>('idle');
  loading = $state(false);
  /** File being read right now (name + size) for the Choose step's "reading" state. */
  pending = $state.raw<{ name: string; size: number } | null>(null);
  picked = $state.raw<PickedApk | null>(null);
  /** Size of the picked file in bytes (the worker takes ownership of the buffer, so `picked.bytes` is empty afterwards). */
  fileSize = $state(0);
  loaded = $state.raw<LoadedApk | null>(null);
  report = $state.raw<ApplicableReport>([]);
  selected = $state<string[]>([]);
  progress = $state<{ stage: ProgressStage; fraction: number }>({ stage: 'read', fraction: 0 });
  result = $state.raw<PatchApkResult | null>(null);
  /** Raw thrown value; render with describeError() so it is translated. */
  error = $state.raw<unknown>(null);
  /** Name of the last file the user gave us (kept for the Choose step's error message). */
  lastName = $state<string | null>(null);
  unsupported = $state.raw<Unsupported | null>(null);
  /** True after a failed patch run (not a cancel): the Patch step shows the failure screen. */
  runFailed = $state(false);
  /** Technical log for bug reports: real stage transitions with timestamps. */
  log = $state.raw<LogLine[]>([]);

  private abort: AbortController | null = null;
  private loadSeq = 0;

  constructor(
    readonly platform: PlatformAdapter,
    readonly engine: Engine,
    /** Reads the pinned mod loader zip (only when the mod-loader patch is selected). */
    private readonly loadModLoader: () => Promise<Uint8Array> = () => fetchModLoader(),
  ) {}

  /** Wizard step 1..4 for the step indicator. */
  step = $derived(
    this.stage === 'idle' || (this.stage === 'error' && !this.loaded) ? 1 : this.stage === 'loaded' ? 2 : this.stage === 'patching' ? 3 : this.stage === 'done' ? 4 : 2
  );

  private addLog(kind: string, text: string): void {
    this.log = [...this.log, { time: new Date(), kind, text }];
  }

  async load(p: PickedApk): Promise<void> {
    const seq = ++this.loadSeq;
    this.error = null;
    this.unsupported = null;
    this.lastName = p.name;
    const size = p.bytes.length;
    this.pending = { name: p.name, size };
    this.loading = true;
    this.log = [];
    this.addLog('read', `${p.name} (${formatBytes(p.bytes.length, 'en')})`);
    try {
      await tick();
      const loaded = await this.engine.loadApk(p.bytes);
      const report = this.engine.listPatches(loaded);
      if (seq !== this.loadSeq) { this.engine.release?.(loaded); return; }
      const { packageName, versionName, versionCode } = loaded.info;
      this.addLog('detect', `${packageName} version ${versionName} (code ${versionCode})`);
      if (report.length > 0 && report.every((r) => r.status === 'incompatible')) {
        this.engine.release?.(loaded);
        this.unsupported = { name: p.name, packageName, versionName, versionCode, wrongPackage: packageName !== GAME_PACKAGE, reason: report[0]!.reasonCode };
        this.addLog('error', `no patch applies: ${report[0]!.reasonCode?.code ?? 'incompatible'}`);
        return;
      }
      this.adopt(p, loaded, report, size);
    } catch (e) {
      if (seq === this.loadSeq) { this.addLog('error', errorText(e)); this.fail(e); }
    } finally {
      if (seq === this.loadSeq) { this.loading = false; this.pending = null; }
    }
  }

  /** Abandons a file that is still being read; its result is dropped. */
  cancelLoad(): void {
    this.loadSeq++;
    this.loading = false;
    this.pending = null;
  }

  private adopt(p: PickedApk, loaded: LoadedApk, report: ApplicableReport, size: number): void {
    this.picked = p;
    this.fileSize = size;
    this.loaded = loaded;
    this.report = report;
    this.selected = report.filter((r) => r.status === 'notApplied' && !r.patch.optIn).map((r) => r.patch.id);
    this.stage = 'loaded';
  }

  async run(): Promise<void> {
    const picked = this.picked, loaded = this.loaded;
    if (!picked || !loaded || this.selected.length === 0) return;
    this.error = null;
    this.runFailed = false;
    this.stage = 'patching';
    this.progress = { stage: 'read', fraction: 0 };
    this.addLog('patch', `start: ${this.selected.join(', ')}`);
    const abort = this.abort = new AbortController();
    let last: ProgressStage | null = null;
    try {
      await tick();
      if (this.selected.includes('mod-loader')) {
        await this.engine.setModLoader(await this.loadModLoader());
        this.addLog('patch', 'mod loader files checked');
      }
      // Reuse the already parsed archive (no second read/inflate); it is mutated, so drop it afterwards.
      this.result = await this.engine.patchLoaded(loaded, {
        // registry order, whatever order the patches were ticked in: the same selection always patches the same way
        patchIds: this.report.map((r) => r.patch.id).filter((id) => this.selected.includes(id)),
        signal: abort.signal,
        onProgress: (stage, fraction) => {
          this.progress = { stage, fraction };
          if (stage !== last) { last = stage; this.addLog(stage, stage === 'sign' ? 'signing' : stage === 'done' ? 'finished' : 'complete'); }
        }
      });
      this.addLog('done', `${this.result.suggestedFileName} (${formatBytes(this.result.bytes.length, 'en')})`);
      this.loaded = null; this.picked = null; this.report = [];
      this.stage = 'done';
    } catch (e) {
      // The parsed archive may be half-patched: restore it (the worker keeps the input) or parse the original bytes again.
      try {
        if (this.engine.reload) {
          await this.engine.reload(loaded);
          this.report = this.engine.listPatches(loaded);
          this.stage = 'loaded';
        } else {
          const fresh = await this.engine.loadApk(picked.bytes);
          this.adopt(picked, fresh, this.engine.listPatches(fresh), this.fileSize);
        }
      } catch { this.loaded = null; }
      if (isCancelled(e)) { this.addLog('cancel', 'cancelled by user'); this.stage = this.loaded ? 'loaded' : 'idle'; }
      else { this.addLog('error', errorText(e)); this.runFailed = true; this.fail(e); }
    } finally {
      this.abort = null;
    }
  }

  /** Lists the patches of the loaded APK again (the imported packs changed); the selection keeps what still applies. */
  async refresh(): Promise<void> {
    const loaded = this.loaded;
    if (!loaded || this.stage !== 'loaded') return;
    if (this.engine.reload) await this.engine.reload(loaded);
    if (this.loaded !== loaded) return;
    this.report = this.engine.listPatches(loaded);
    const open = new Set(this.report.filter((r) => r.status === 'notApplied').map((r) => r.patch.id));
    this.selected = this.selected.filter((id) => open.has(id));
  }

  /** Cancels a running patch; the loaded APK stays available. */
  cancel(): void {
    this.abort?.abort();
  }

  back(): void {
    this.error = null;
    this.result = null;
    this.runFailed = false;
    this.stage = this.loaded ? 'loaded' : 'idle';
  }

  reset(): void {
    if (this.loaded) this.engine.release?.(this.loaded);
    this.stage = 'idle';
    this.picked = null; this.loaded = null; this.report = []; this.selected = [];
    this.result = null; this.error = null; this.unsupported = null; this.runFailed = false; this.lastName = null; this.log = [];
  }

  private fail(e: unknown): void {
    this.error = e;
    this.stage = this.loaded ? 'error' : 'idle';
  }
}
