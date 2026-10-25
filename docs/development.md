# Developing Blockheads Patcher

Build, test, deploy and release notes for contributors. Module contracts: [ARCHITECTURE.md](ARCHITECTURE.md).
Patch pack format: [patch-packs.md](patch-packs.md).

## Repository layout

| Path | Purpose |
|---|---|
| `packages/core` | Pure TypeScript patch engine (zip, binary XML, APK signing v1+v2, patches, pipeline) |
| `app` | SvelteKit 2 + Svelte 5 static app (web + Tauri webview) |
| `app/src-tauri` | Tauri 2 project (Windows desktop + Android) |
| `plugins/tauri-plugin-apk-tools` | Tauri plugin: Kotlin (Android installed-APK access, uninstall, install) |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Module contracts |
| [`patch-packs.md`](patch-packs.md), `examples/packs` | Patch pack format and an example pack (`bun scripts/build-pack.ts <folder>`) |

## Patch versions

Every patch has an integer `version` (`Patch.version`, default 1) that names the output it writes. **Bump it whenever the
bytes the patch writes change** (a different value, a different replacement code, another asset); a change that only
refactors the code or the detection of the same output does not bump it. A bumped patch must stop recognising the old
output as its own (`detect` returns `applied` only for the current output), and it must either know how to turn the old
output into the new one or say that it cannot.

What the Patcher stores: before signing, every run writes `assets/blockheads-patcher.json` into the APK, for example
`{"patcher":"0.3.3","patches":{"fix-system-font-crash":1,"mod-loader":3001},"schema":1}` (sorted keys, no whitespace). It
names, for each patch whose output the APK holds, the version of that output. `loadApk` reads it into `LoadedApk.record`.

Status, in this order:

1. `detect()` says `applied`: applied (the content shows the current output, whatever the record says).
2. Otherwise the older version is `patch.installedVersion?.(ctx)` (content evidence) or else the record's entry. When it is
   below `patch.version`, or `detect()` itself returns `outdated`, the status is `outdated` (the review screen shows
   "Update: v1 → v2", ticked by default for recommended patches). `fromVersion` is that older version, when known.
3. Anything else keeps its content status. An APK without a record, and a patch that cannot read its own old output,
   never get an `outdated` claim: nothing is said without evidence.

Applying an `outdated` patch calls `patch.upgrade(ctx, from)`, which must leave the APK with exactly the current output
(undo the old output and apply the new one, or edit in place). A patch without `upgrade` cannot be updated in place:
`listPatches` reports `canUpgrade: false`, the review screen shows "Update needs the original APK" (not tickable) and
`applyPatches` throws a `PatchError` with code `needsOriginal` instead of skipping or applying twice. Re-patch the
original game APK to get the new output. Patch factories (`makeBooleanFlagPatch`, `makeMethodRewritePatch`,
`makeTranslucentActivityPatch`, `makeNativePatch`) take `version`, `versionLabel`, `installedVersion` and `upgrade` in
their spec.

To bump a patch: raise `version`, change `detect` so it no longer accepts the old bytes, add `upgrade` if the old
output can be rewritten (and `installedVersion` if the old output is recognisable without a record), and add a test that
patches with the old version, lists with the new one (`outdated`, `fromVersion`), upgrades, and checks the record and
`applied`. The record is rebuilt after every run: patches whose current output is in the APK are written at their
current version.

Which patches update in place today: only the mod loader (its version is the loader build, `major.minor.patch` as
`major * 1_000_000 + minor * 1_000 + patch`, from `MOD_LOADER_PIN` or the build set with `setModLoaderArtifact`; an
older `libbhmodloader.so` is recognised by its hash in `KNOWN_LOADER_LIBS` or by the record; `upgrade` replaces the
library and the loader dex). Every other built-in patch is at version 1 and has no `upgrade`, so the first bump of
one of them either brings an `upgrade` or needs the original game APK (the native-library and dex-rewrite patches
check the original bytes of the code they replace, so they will normally need the original). Pack patches carry the
pack's `major.minor.patch` as their version and cannot be updated in place.

## Build

Prerequisites: [bun](https://bun.sh), Rust stable (rustup). `bun install` at the repo root.

```sh
bun run check      # type checks (all workspaces)
bun run test       # unit tests (all workspaces)
bun run test:fast  # quick loop: unit tests + the 1.7.6 real-APK tests, no coverage (NOT a gate)
bun run test:cov   # the gate: every test, all three game versions, 100 % coverage thresholds
```

Real-APK tests run against your own game APKs (see `packages/core/tests/helpers.ts`) and are skipped when they are
absent. `BH_REAL_VERSIONS=1.7.6` (comma separated) limits them to some versions, `BH_SKIP_REAL=1` skips them all.
Each APK is opened once per run: a vitest globalSetup (`packages/core/tests/setup/`) computes the JAR digests of its
entries with Node's zlib/crypto, caches them in `~/.cache/bh-patcher` (`BH_PATCHER_CACHE`) keyed by the APK's SHA-256
and seeds every test worker, so the many patch-and-sign tests do not each inflate ~150 MB again. The slow suites are
split into one file per game version so the versions run in parallel.

### Web (static)
```sh
bun run dev                              # dev server on :1420
bun run --filter @bh-patcher/app build   # output: app/build
```

### Windows desktop
```sh
cd app
bun run tauri build                      # on Windows
# from Linux (cross-check): cargo xwin check --target x86_64-pc-windows-msvc  (in app/src-tauri)
```

### Android
Requires Android SDK, NDK 27, JDK 17 or 21 (Gradle/AGP do not support JDK 26), rust android targets.
```sh
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
export ANDROID_HOME=~/Android/Sdk NDK_HOME=~/Android/Sdk/ndk/27.2.12479018
cd app
bun run tauri android init               # once
bun run tauri android build --apk
```

### E2E
`cd app && bunx playwright install chromium && bun run test:e2e`

## Deploy

The app is fully static (no server). Two web targets:

| Target | How | Notes |
| --- | --- | --- |
| **blockheads.club/patcher/** (primary) | Bundled into the website (Blockheads-Club/website) | The website's `bun run build` (`scripts/build-patcher.ts` there) clones the **latest published release** of this repo, builds it with `BASE_PATH=/patcher` (`build:web`) and ships it as plain static files of its assets-only Worker `blockheads-club-website`, with this app's `_headers` merged under `/patcher`. Nothing to deploy from this repo; publishing a release triggers a website rebuild (below). |
| GitHub Pages (project site, `/blockheads-patcher/`) | `deploy-pages.yml` (push to `dev`, manual) | Built with `BASE_PATH=/blockheads-patcher`; `.nojekyll` and a `404.html` SPA fallback are emitted. Enable Pages with source "GitHub Actions" and allow the `dev` branch in the `github-pages` environment rules. Kept running because keys and packs live in the browser's storage per origin; users of the old address keep them there. |

```sh
bun run --filter @bh-patcher/app build:web                                 # root-hosted (local preview, release zip)
BASE_PATH=/blockheads-patcher bun run --filter @bh-patcher/app build:web   # GitHub Pages
BASE_PATH=/patcher bun run --filter @bh-patcher/app build:web              # what the website bundles
```

`build:web` runs `app/scripts/finalize-web.mjs`, which writes the sha256 of SvelteKit's inline bootstrap script into
`_headers` (strict CSP: no `unsafe-inline` for scripts, `worker-src 'self' blob:`) and creates `404.html`.
GitHub Pages ignores `_headers`/`_redirects`. The website drops `_redirects`, keeps `404.html` (Workers assets serve
the nearest `404.html` for unknown `/patcher/*` paths) and copies `index.html` to `<route>.html` for each static route
(e.g. `splash.html`), so keep routes static or expect deep links to them to answer 404 (the app still boots).

`build:worker`, `app/scripts/build-worker.mjs` and `wrangler.toml` (the former separate Worker
`blockheads-patcher-web`) are no longer used by any deployment; no Cloudflare project should be connected to this repo.

### Website rebuild on release

`.github/workflows/website-rebuild.yml` runs when a release is **published** (and by hand) and POSTs to the website
Worker's Cloudflare deploy hook, stored as the repository secret `WEBSITE_DEPLOY_HOOK`; without the secret it only
logs a notice. Create the hook in the Cloudflare dashboard (Workers & Pages → `blockheads-club-website` → Settings →
Builds → Deploy Hooks, branch = the website's production branch) and add its URL under this repo's Settings → Secrets
and variables → Actions. Full steps in the website's `docs/development.md`.

The app e2e suite also runs under a base path against a local website build
(`BASE_PATH=/patcher E2E_PORT=8787 bunx playwright test` in `app/`, with the website's `npx wrangler dev --port 8787`
running; Playwright reuses the server).

## Releases

Push a signed tag `vX.Y.Z` on `dev` (versions follow `app/package.json`, `app/src-tauri/Cargo.toml` and
`tauri.conf.json`). `release.yml` (on a `v*` tag, or manual with the tag as input) builds every bundle and attaches it to
a **draft** GitHub release for that tag (marked prerelease only for `-pre` tags such as `v0.2.0-rc.1`); publish the draft once CI is green.
A manual run with an empty tag is a dry run of the dispatched commit: it uploads the bundles as workflow artifacts only.

- Windows x64 + arm64: NSIS `.exe` + `.msi`; Linux x64 + arm64: `.AppImage`, `.deb`, `.rpm` (built on Ubuntu 22.04)
- macOS: universal `.dmg` (arm64 + x86_64) plus per-arch `aarch64` / `x64` `.dmg`
- Android APKs per ABI: `arm64-v8a`, `armeabi-v7a`, `x86_64`. Release-signed when the secrets `ANDROID_KEYSTORE_BASE64`,
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` exist, otherwise debug-signed
- `blockheads-patcher-web-<version>.zip` (static site)
- `SHA256SUMS.txt` over every asset. Spaces in bundle names are replaced with dots first (as GitHub does on upload), so
  `sha256sum -c SHA256SUMS.txt` works in a folder of downloaded assets

MSI requires numeric prerelease identifiers, so bundle metadata uses `1.0.0-3` for `1.0.0-dev.3` (release tag/asset names keep the full version).
Desktop bundles are unsigned/not notarized unless you add signing secrets. Every workflow has `workflow_dispatch`.

## App updates

The app checks for a newer version itself (update icon in the app bar, Settings → Updates; automatic check at most
once a day when the app opens, can be switched off). A check only shows the popup: **nothing is downloaded or
installed until the user clicks the update button** (same rule as the Blockheads PC launcher). Code:
`packages/core/src/update/` (release selection, notes, asset choice, `latest.json`) and `app/src/lib/update.svelte.ts`.

- **Feed:** the GitHub REST releases of this repository. Drafts are skipped; only tags `vX.Y.Z` count, pre-releases
  (`-` suffix or the GitHub flag) only on the "Pre-release" channel. Release notes in the popup are the bullets of the
  `## What's new` section of the release body (or of the whole body), so keep that heading in release notes.
- **Web:** blockheads.club serves the latest published release, so the web app fetches `<base>/version.json`
  (prerendered by `src/routes/version.json/+server.ts`) and, for deployments older than this feature, the website's
  `patcher-version.txt`, with `cache: no-store`. A newer deployed version offers "Reload now" (and prefixes the tab
  title with ↑). There is no service worker, so a reload always loads the new build (`/_app/immutable/*` files are
  content-hashed).
- **Desktop (in place):** "Download and install" runs the Tauri updater (`tauri-plugin-updater`, desktop only). It reads
  `https://github.com/Blockheads-Club/blockheads-patcher/releases/latest/download/latest.json`, downloads the file for
  this platform, verifies its minisign signature against `plugins.updater.pubkey` in `tauri.conf.json`, then waits:
  "Restart now" installs (Windows: NSIS in passive mode, which closes the app) and restarts (`app_restart` command).
  Restart is disabled while a patch runs. In-place covers Windows (NSIS), macOS (`.app.tar.gz`) and Linux AppImage.
  `latest.json` points Windows at the NSIS installer: MSI installs then get a second (NSIS, per-user) install, so
  recommend the `-setup.exe` for downloads.
- **Desktop (browser fallback):** `.deb`/`.rpm` installs (release page), a pre-release that `latest.json` does not
  describe, or any updater error open the installer download (or release page) in the system browser instead. The
  Rust command `update_target` reports OS, arch and `$APPIMAGE`. The Tauri CSP allows `connect-src https://api.github.com`;
  the opener plugin may open only `https://github.com/Blockheads-Club/blockheads-patcher/releases/*` and
  `https://blockheads.club/*` (capabilities/default.json).
- **Android (in app):** the check runs at every launch (desktop and web: at most once a day). "Download and install"
  downloads the APK for the app's ABI inside the app (`UpdateDownloader.kt` in `plugins/tauri-plugin-apk-tools`: only
  this repository's release URLs, redirects followed by hand), with progress. It checks the size and, when the release
  has `SHA256SUMS.txt`, the file's SHA-256 against it (a missing entry or mismatch fails the download). Then the popup
  says "Install": the tap hands the file to the system installer (`install_apk`, PackageInstaller session). When Android
  does not yet allow this app to install packages, the "install unknown apps" screen opens (the update stays downloaded)
  and the user taps Install again. Nothing is installed without that tap. A failed download falls back to the browser
  (the APK, as before). The update installs over the current app only because every release APK is signed with the same
  release key (the `ANDROID_*` secrets); a debug-signed build (no secrets) cannot update a release install.

### Updater signing (release.yml)

- Secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the maintainer's minisign key; the public
  half is `plugins.updater.pubkey`). When the key is set, the desktop jobs build with `bundle.createUpdaterArtifacts`
  (passed on the command line, so local `bun tauri build` needs no key) and upload a `.sig` for every installer,
  AppImage and macOS `.app.tar.gz` (renamed `Blockheads.Patcher_<version>_<universal|aarch64|x64>.app.tar.gz`).
- The publish job writes `latest.json` (`scripts/updater-manifest.ts`) for the six desktop targets (Windows, Linux and
  macOS, each x64 and arm64) before `SHA256SUMS.txt`; it fails if one is missing. Without signatures (no key) it is skipped.
- `latest.json` is only reachable through `releases/latest/...` once the release is **published** (drafts and
  pre-releases are not "latest"), so desktop installs see an update right after publishing.
- Losing the private key means existing installs can no longer update in place (they still get the browser fallback);
  rotating it needs a release that ships the new public key, signed with the old key.
- Local test of the signing path with a throwaway key: `bun tauri signer generate --ci -p x -w ~/.cache/<dir>/k.key`,
  `TAURI_SIGNING_PRIVATE_KEY_PATH=… TAURI_SIGNING_PRIVATE_KEY_PASSWORD=x bun tauri signer sign <file>`, then
  `bun scripts/updater-manifest.ts <dir> <version> <tag>`.

## CI

`ci.yml`: `check` (svelte-check + tsc), `test` (vitest with 100% coverage thresholds, defined in the vitest configs),
`e2e` (Playwright), `clippy` (`-D warnings`), `desktop-check` (`cargo check` on Windows x64/arm64, Linux arm64 and
macOS), `kotlin` (JDK 17 Android compile via a debug build).

## Third-party fonts

Third-party font: the `fix-system-font-crash` patch embeds subsets of Noto Sans Regular, Bold and Italic (Copyright 2022
The Noto Project Authors), licensed under the SIL Open Font License 1.1 (`packages/core/src/patches/fonts/OFL.txt`). They
are free fonts from the Noto Project, not game files; `scripts/fonts/noto-sans-subset.py` regenerates them.
