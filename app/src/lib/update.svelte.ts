// App updates (docs/development.md, "App updates"). Native builds read the GitHub releases of the patcher. Desktop
// updates in place with the Tauri updater (signed latest.json of the latest release): download, verify, then install and
// restart when the user says so; when that is not possible (.deb/.rpm, pre-release channel, updater error) it hands the
// installer to the system browser, like Android does with the APK. The web app is served by blockheads.club at the
// latest release, so it compares the deployed version with the running one and offers a reload.
// Nothing is downloaded or installed until the user chooses to update: checks only show the popup.
import {
  PATCHER_REPO, fetchLatestRelease, isNewer, parseDeployedVersion, pickAsset, releaseNoteItems, type UpdateTarget
} from '@bh-patcher/core';
import { base } from '$app/paths';
import type { InPlaceUpdate, PlatformAdapter, PlatformKind } from './platform/types';

export type UpdateStage = 'idle' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
/** Stages of an in-place update that a check must not interrupt. */
const UPDATING: UpdateStage[] = ['downloading', 'ready', 'installing'];
export interface DownloadProgress { done: number; total: number | null; /** bytes per second */ speed: number; /** seconds */ eta: number | null }
/** `beta` also offers pre-releases (`vX.Y.Z-rc.N`). */
export type Channel = 'stable' | 'beta';
export interface UpdateInfo {
  version: string;
  notes: string[];
  /** Release page (full notes, every download). */
  page: string;
  /** The file that updates this install; absent when the user has to pick one on the release page. */
  download?: { name: string; url: string; size: number };
  /** Desktop: the Tauri updater can install it in place. */
  inPlace?: boolean;
}
export interface UpdateDeps {
  kind: PlatformKind;
  current: string;
  /** Web: the app's base path ("" or "/patcher"), where version.json is served. */
  base?: string;
  fetch?: typeof fetch;
  openUrl(url: string): Promise<void>;
  reload?(): void;
  target?(): Promise<UpdateTarget>;
  checkInPlace?(): Promise<InPlaceUpdate | null>;
  restart?(): Promise<void>;
  now?(): number;
}

export const DAY_MS = 86_400_000;
export const RELEASES_URL = `https://github.com/${PATCHER_REPO}/releases/latest`;
export const releasePage = (version: string) => `https://github.com/${PATCHER_REPO}/releases/tag/v${version}`;

const K = { auto: 'bhp.upd.auto', channel: 'bhp.upd.channel', checked: 'bhp.upd.checked', ok: 'bhp.upd.ok', latest: 'bhp.upd.latest', seen: 'bhp.upd.seen' };
function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: kept for this session only */ }
}
const num = (key: string) => Number(read(key)) || 0;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class UpdateState {
  stage = $state<UpdateStage>('idle');
  info = $state<UpdateInfo | null>(null);
  error = $state('');
  /** The popup is open. */
  open = $state(false);
  /** An automatic check found a version the popup has not shown yet; App opens it when nothing else is going on. */
  pending = $state(false);
  /** Native: the download or the release page was handed to the system. */
  handedOff = $state(false);
  /** The error stage comes from a failed install, not a failed check. */
  installFailed = $state(false);
  autoCheck = $state(read(K.auto) !== '0');
  channel = $state<Channel>(read(K.channel) === 'beta' ? 'beta' : 'stable');
  /** Last attempt and last successful check (ms since epoch, 0 = never). */
  lastChecked = $state(num(K.checked));
  lastSuccess = $state(num(K.ok));
  progress = $state<DownloadProgress | null>(null);
  private ctrl: AbortController | null = null;
  /** Bumped to drop a running download (Cancel download, channel change). */
  private dl = 0;
  private handle: InPlaceUpdate | null = null;

  constructor(private deps: UpdateDeps) {}

  get kind(): PlatformKind { return this.deps.kind; }
  get web(): boolean { return this.deps.kind === 'web'; }
  get current(): string { return this.deps.current; }
  /** Download progress in percent (0 while the size is unknown). */
  get percent(): number {
    const p = this.progress;
    return p?.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }

  setAutoCheck(v: boolean): void { this.autoCheck = v; write(K.auto, v ? '1' : '0'); }
  setChannel(c: Channel): void {
    if (c === this.channel) return;
    this.channel = c;
    write(K.channel, c);
    this.cancel();
    this.dropUpdate();
    this.info = null;
    this.stage = 'idle';
    this.handedOff = false;
  }

  /** Startup: checks at most once a day, or again when a newer version was found before (to show its notes). */
  autoStart(): void {
    if (!this.autoCheck) return;
    const known = read(K.latest);
    if (this.now() - this.lastChecked >= DAY_MS || (known !== null && isNewer(known, this.current))) void this.check();
  }

  /** `popup`: the user asked (update icon) and sees the result in the popup; otherwise only a new version opens it. */
  async check({ popup = false }: { popup?: boolean } = {}): Promise<void> {
    if (UPDATING.includes(this.stage)) { if (popup) this.open = true; return; }
    this.ctrl?.abort();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.stage = 'checking';
    this.error = '';
    this.handedOff = false;
    this.installFailed = false;
    if (popup) this.open = true;
    try {
      const info = this.web ? await this.checkDeployed(ctrl.signal) : await this.checkReleases(ctrl.signal);
      if (ctrl !== this.ctrl) return;
      this.ctrl = null;
      this.lastChecked = this.lastSuccess = this.now();
      write(K.checked, String(this.lastChecked));
      write(K.ok, String(this.lastSuccess));
      this.info = info;
      this.stage = info ? 'available' : 'uptodate';
      if (info) {
        write(K.latest, info.version);
        if (!popup && !this.open && read(K.seen) !== info.version) this.pending = true;
      }
    } catch (e) {
      if (ctrl !== this.ctrl) return;
      this.ctrl = null;
      this.lastChecked = this.now();
      write(K.checked, String(this.lastChecked));
      this.stage = 'error';
      this.error = message(e);
    }
  }

  /** Stops a running check (popup Cancel). */
  cancel(): void {
    if (!this.ctrl) return;
    this.ctrl.abort();
    this.ctrl = null;
    this.stage = 'idle';
    this.open = false;
  }

  /** The update icon: opens the popup; when there is nothing to show it starts a check (shown in the popup). */
  show(): void {
    if (this.stage === 'idle' || this.stage === 'uptodate') { void this.check({ popup: true }); return; }
    this.open = true;
    this.pending = false;
    if (this.info) write(K.seen, this.info.version);
  }
  hide(): void { this.open = false; }

  /** The popup's main action: reload (web), update in place (desktop) or hand the installer / APK to the system. */
  async install(): Promise<void> {
    const info = this.info;
    if (!info) return;
    if (this.web) { this.deps.reload?.(); return; }
    if (info.inPlace) { await this.updateInPlace(info); return; }
    await this.handOff(info);
  }

  private async handOff(info: UpdateInfo): Promise<void> {
    try {
      await this.deps.openUrl(info.download?.url ?? info.page);
      this.handedOff = true;
    } catch (e) {
      this.stage = 'error';
      this.error = message(e);
    }
  }

  /** Downloads and verifies the update with the Tauri updater; falls back to the browser when it cannot. */
  private async updateInPlace(info: UpdateInfo): Promise<void> {
    const seq = ++this.dl;
    this.stage = 'downloading';
    this.error = '';
    this.progress = { done: 0, total: null, speed: 0, eta: null };
    let handle: InPlaceUpdate | null = null;
    try {
      handle = await this.deps.checkInPlace!();
      if (seq !== this.dl) { await handle?.close(); return; }
      if (!handle || handle.version !== info.version) {
        // The updater endpoint serves the latest stable release only (pre-release channel, release still a draft).
        await handle?.close();
        this.stage = 'available';
        this.progress = null;
        await this.handOff(info);
        return;
      }
      const start = this.now();
      await handle.download(({ done, total }) => {
        if (seq !== this.dl) return;
        const secs = (this.now() - start) / 1000;
        const speed = secs > 0 ? done / secs : 0;
        this.progress = { done, total, speed, eta: total !== null && speed > 0 ? Math.max(0, Math.round((total - done) / speed)) : null };
      });
      if (seq !== this.dl) { await handle.close(); return; }
      this.handle = handle;
      this.stage = 'ready';
    } catch (e) {
      await handle?.close().catch(() => {});
      if (seq !== this.dl) return;
      this.stage = 'available';
      this.progress = null;
      this.error = message(e);
      await this.handOff(info);
    }
  }

  /** Popup "Cancel download": back to the offer. */
  cancelDownload(): void {
    this.dropUpdate();
    this.stage = 'available';
  }

  private dropUpdate(): void {
    this.dl++;
    this.progress = null;
    void this.handle?.close().catch(() => {});
    this.handle = null;
  }

  /** Popup "Restart now": installs the downloaded update and restarts (Windows: the installer closes the app). */
  async restart(): Promise<void> {
    const handle = this.handle;
    if (!handle) return;
    this.stage = 'installing';
    try {
      await handle.install();
      await this.deps.restart?.();
    } catch (e) {
      this.handle = null;
      void handle.close().catch(() => {});
      this.stage = 'error';
      this.installFailed = true;
      this.error = message(e);
    }
  }

  /** Full release notes / every download: the release page (or the latest release when nothing was found yet). */
  openPage(): void {
    void this.deps.openUrl(this.info?.page ?? RELEASES_URL).catch(() => {});
  }

  private async checkDeployed(signal: AbortSignal): Promise<UpdateInfo | null> {
    const f = this.deps.fetch ?? fetch;
    const base = this.deps.base ?? '';
    for (const file of ['version.json', 'patcher-version.txt']) {
      const res = await f(`${base}/${file}?t=${this.now()}`, { cache: 'no-store', signal });
      const version = res.ok ? parseDeployedVersion(await res.text()) : null;
      if (version) return isNewer(version, this.current) ? { version, notes: [], page: releasePage(version) } : null;
    }
    throw new Error('the deployed version is unknown');
  }

  private async checkReleases(signal: AbortSignal): Promise<UpdateInfo | null> {
    const rel = await fetchLatestRelease(this.deps.fetch ?? fetch, { allowPrerelease: this.channel === 'beta', signal });
    if (!rel || !isNewer(rel.tag_name, this.current)) return null;
    const target = await this.deps.target?.().catch(() => undefined);
    const asset = target ? pickAsset(rel.assets, target) : null;
    return {
      version: rel.tag_name.replace(/^v/, ''),
      notes: releaseNoteItems(rel.body),
      page: rel.html_url,
      download: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : undefined,
      inPlace: !!(asset && this.deps.checkInPlace)
    };
  }
}

/** The update state of this app: platform seams wired in (browser reload, system browser, Rust target). */
export function createUpdateState(platform: PlatformAdapter, current: string = __APP_VERSION__): UpdateState {
  return new UpdateState({
    kind: platform.kind,
    current,
    base,
    openUrl: async (url) => { await platform.openUrl?.(url); },
    reload: () => location.reload(),
    target: platform.updateTarget,
    checkInPlace: platform.checkInPlaceUpdate,
    restart: platform.restart
  });
}
