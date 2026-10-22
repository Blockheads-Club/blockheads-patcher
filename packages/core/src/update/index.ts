// Release feed helpers for the app's update check (pure, no I/O except the injected fetch in `fetchLatestRelease`).
// Releases are the GitHub releases of the patcher repository, tagged `vX.Y.Z` (stable) or `vX.Y.Z-pre.N`
// (pre-release, see .github/workflows/release.yml).

export const PATCHER_REPO = 'Blockheads-Club/blockheads-patcher';

export interface SemVer { major: number; minor: number; patch: number; pre: string[] }

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses `1.2.3`, `v1.2.3` or `v1.2.3-rc.1` (build metadata is ignored). */
export function parseVersion(text: string): SemVer | null {
  const m = SEMVER.exec(text.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length; // a release sorts after its pre-releases
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!, y = b[i]!;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) - Number(y); continue; }
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** Semantic-version order: negative when a < b, 0 when equal, positive when a > b. Unparsable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch || comparePre(x.pre, y.pre);
}

export function isNewer(candidate: string, current: string): boolean {
  return parseVersion(candidate) !== null && compareVersions(candidate, current) > 0;
}

/** The fields of a GitHub REST release the update check uses. */
export interface ReleaseAsset { name: string; size: number; browser_download_url: string }
export interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  body?: string | null;
  published_at?: string | null;
  assets: ReleaseAsset[];
}

/**
 * The newest release by version. Drafts are skipped, and so are tags that are not `vX.Y.Z[-pre]`. Pre-releases
 * (GitHub flag or a `-` suffix) count only when `allowPrerelease` is set.
 */
export function pickLatestRelease(releases: Release[], allowPrerelease = false): Release | null {
  let best: Release | null = null;
  for (const r of releases) {
    const v = /^v/.test(r.tag_name) ? parseVersion(r.tag_name) : null;
    if (r.draft || !v) continue;
    if (!allowPrerelease && (r.prerelease || v.pre.length > 0)) continue;
    if (!best || compareVersions(r.tag_name, best.tag_name) > 0) best = r;
  }
  return best;
}

/** Plain text of one Markdown line: links keep their text, emphasis and code marks go. */
function plain(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Short release notes for the popup: the top-level bullets of the "What's new" section (or of the whole body when
 * there is no such heading), as plain text, at most `max` items.
 */
export function releaseNoteItems(body: string | null | undefined, max = 5): string[] {
  const lines = (body ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+what.s new/i.test(l.trim()));
  const from = start >= 0 ? start + 1 : 0;
  const items: string[] = [];
  for (let i = from; i < lines.length && items.length < max; i++) {
    const line = lines[i]!;
    if (start >= 0 && /^#{1,6}\s/.test(line.trim())) break;
    const m = /^[-*+]\s+(.*)$/.exec(line);
    if (m) {
      const text = plain(m[1]!);
      if (text) items.push(text);
    }
  }
  return items;
}

export type TargetOs = 'windows' | 'macos' | 'linux' | 'android';
/** Where the app runs: `os` and `arch` as Rust's std::env::consts report them; `appimage` when run as an AppImage. */
export interface UpdateTarget { os: TargetOs; arch: string; appimage?: boolean }

const ARCH: Record<string, Partial<Record<TargetOs, string[]>>> = {
  x86_64: { windows: ['_x64-setup.exe'], macos: ['_x64.dmg', '_universal.dmg'], linux: ['_amd64.AppImage'], android: ['-android-x86_64.apk'] },
  aarch64: { windows: ['_arm64-setup.exe'], macos: ['_aarch64.dmg', '_universal.dmg'], linux: ['_aarch64.AppImage'], android: ['-android-arm64.apk'] },
  arm: { android: ['-android-arm.apk'] }
};

/**
 * The release file that updates this install: the NSIS installer on Windows, the DMG on macOS, the APK for the
 * device's ABI on Android and the AppImage when running as one. Linux .deb/.rpm installs get null (the user picks
 * the package from the release page), as does an unknown architecture.
 */
export function pickAsset(assets: ReleaseAsset[], target: UpdateTarget): ReleaseAsset | null {
  if (target.os === 'linux' && !target.appimage) return null;
  for (const suffix of ARCH[target.arch]?.[target.os] ?? []) {
    const hit = assets.find((a) => a.name.endsWith(suffix));
    if (hit) return hit;
  }
  return null;
}

/**
 * The version a web deployment serves: the app's own `version.json` (`{"version":"0.2.0"}`) or the website's
 * `patcher-version.txt` (`v0.2.0 <commit>`). Null when the text holds no version.
 */
export function parseDeployedVersion(text: string): string | null {
  let candidate = text.trim().split(/\s+/)[0]!;
  try {
    const json = JSON.parse(text) as { version?: unknown };
    if (json && typeof json === 'object') candidate = typeof json.version === 'string' ? json.version : '';
  } catch { /* not JSON: plain text */ }
  const v = parseVersion(candidate);
  return v ? candidate.replace(/^v/, '') : null;
}

/** Fetches the release list of `repo` and returns the newest eligible release (see `pickLatestRelease`). */
export async function fetchLatestRelease(
  fetcher: typeof fetch,
  opts: { allowPrerelease?: boolean; repo?: string; signal?: AbortSignal } = {}
): Promise<Release | null> {
  const res = await fetcher(`https://api.github.com/repos/${opts.repo ?? PATCHER_REPO}/releases?per_page=20`, {
    headers: { accept: 'application/vnd.github+json' },
    cache: 'no-store',
    signal: opts.signal
  });
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  return pickLatestRelease((await res.json()) as Release[], opts.allowPrerelease);
}

/** Tauri updater platform keys and the release file each one installs (see .github/workflows/release.yml). */
export const UPDATER_PLATFORMS: Record<string, string> = {
  'windows-x86_64': '_x64-setup.exe',
  'windows-aarch64': '_arm64-setup.exe',
  'linux-x86_64': '_amd64.AppImage',
  'linux-aarch64': '_aarch64.AppImage',
  'darwin-x86_64': '_x64.app.tar.gz',
  'darwin-aarch64': '_aarch64.app.tar.gz'
};

export interface UpdaterManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

/**
 * The Tauri updater's `latest.json` for a release: one entry per desktop platform, pointing at the release asset and
 * carrying the content of its `.sig` file. `files` maps asset names to signatures (assets without one are ignored).
 * Throws when a platform has no signed file, so a release never ships a partial manifest.
 */
export function buildUpdaterManifest(opts: {
  version: string; tag: string; files: Record<string, string>; notes?: string; pubDate: string; repo?: string;
}): UpdaterManifest {
  const base = `https://github.com/${opts.repo ?? PATCHER_REPO}/releases/download/${opts.tag}/`;
  const platforms: UpdaterManifest['platforms'] = {};
  for (const [key, suffix] of Object.entries(UPDATER_PLATFORMS)) {
    const name = Object.keys(opts.files).find((n) => n.endsWith(suffix));
    if (!name) throw new Error(`no signed updater file for ${key} (*${suffix})`);
    platforms[key] = { signature: opts.files[name]!.trim(), url: base + encodeURIComponent(name) };
  }
  return { version: opts.version, notes: opts.notes ?? '', pub_date: opts.pubDate, platforms };
}
