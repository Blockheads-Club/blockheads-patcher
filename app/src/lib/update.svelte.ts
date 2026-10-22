// App updates. Native builds (Tauri desktop / Android) read the GitHub releases of the patcher and hand the right
// installer or APK to the system (browser download / Android installer): there is no in-app updater because the
// repository has no Tauri updater signing key (docs/development.md, "App updates"). The web app is served by
// blockheads.club at the latest release, so it compares the deployed version with the running one and offers a reload.
import {
  PATCHER_REPO, fetchLatestRelease, isNewer, parseDeployedVersion, pickAsset, releaseNoteItems, type UpdateTarget
} from '@bh-patcher/core';
import { base } from '$app/paths';
import type { PlatformAdapter, PlatformKind } from './platform/types';

export type UpdateStage = 'idle' | 'checking' | 'uptodate' | 'available' | 'error';
/** `beta` also offers pre-releases (`vX.Y.Z-rc.N`). */
export type Channel = 'stable' | 'beta';
export interface UpdateInfo {
  version: string;
  notes: string[];
  /** Release page (full notes, every download). */
  page: string;
  /** The file that updates this install; absent when the user has to pick one on the release page. */
  download?: { name: string; url: string; size: number };
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
  autoCheck = $state(read(K.auto) !== '0');
  channel = $state<Channel>(read(K.channel) === 'beta' ? 'beta' : 'stable');
  /** Last attempt and last successful check (ms since epoch, 0 = never). */
  lastChecked = $state(num(K.checked));
  lastSuccess = $state(num(K.ok));
  private ctrl: AbortController | null = null;

  constructor(private deps: UpdateDeps) {}

  get kind(): PlatformKind { return this.deps.kind; }
  get web(): boolean { return this.deps.kind === 'web'; }
  get current(): string { return this.deps.current; }
  private now(): number { return this.deps.now?.() ?? Date.now(); }

  setAutoCheck(v: boolean): void { this.autoCheck = v; write(K.auto, v ? '1' : '0'); }
  setChannel(c: Channel): void {
    if (c === this.channel) return;
    this.channel = c;
    write(K.channel, c);
    this.cancel();
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
    this.ctrl?.abort();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.stage = 'checking';
    this.error = '';
    this.handedOff = false;
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

  /** The popup's main action: reload (web) or hand the installer / APK to the system (native). */
  async install(): Promise<void> {
    const info = this.info;
    if (!info) return;
    if (this.web) { this.deps.reload?.(); return; }
    try {
      await this.deps.openUrl(info.download?.url ?? info.page);
      this.handedOff = true;
    } catch (e) {
      this.stage = 'error';
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
      download: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : undefined
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
    target: platform.updateTarget
  });
}
