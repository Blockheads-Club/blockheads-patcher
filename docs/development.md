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
| **blockheads.club/patcher/** (primary) | Cloudflare Workers Builds, Worker `blockheads-patcher-web` (`wrangler.toml`) | Assets-only Worker built by `bun run build:worker`. It has no route or domain of its own: the website Worker (`blockheads-club-website`, repo Blockheads-Club/website) forwards `/patcher` and `/patcher/*` to it through a service binding (`PATCHER`). |
| GitHub Pages (project site, `/blockheads-patcher/`) | `deploy-pages.yml` (push to `dev`, manual) | Built with `BASE_PATH=/blockheads-patcher`; `.nojekyll` and a `404.html` SPA fallback are emitted. Enable Pages with source "GitHub Actions" and allow the `dev` branch in the `github-pages` environment rules. Kept running because keys and packs live in the browser's storage per origin; users of the old address keep them there. |

```sh
bun run --filter @bh-patcher/app build:web                                 # root-hosted (local preview, release zip)
BASE_PATH=/blockheads-patcher bun run --filter @bh-patcher/app build:web   # GitHub Pages
bun run build:worker                                                       # Cloudflare Worker, BASE_PATH defaults to /patcher
```

`build:web` runs `app/scripts/finalize-web.mjs`, which writes the sha256 of SvelteKit's inline bootstrap script into
`_headers` (strict CSP: no `unsafe-inline` for scripts, `worker-src 'self' blob:`) and creates `404.html`.
GitHub Pages ignores `_headers`/`_redirects`.

`build:worker` (`app/scripts/build-worker.mjs`) builds with `BASE_PATH` (default `/patcher`), then stages the output
under `app/build-worker/patcher/` (Worker assets are matched by the full request path), copies `index.html` to
`app/build-worker/index.html` (the shell `not_found_handling = "single-page-application"` serves for deep links such as
`/patcher/splash`) and writes `_headers` with the rules prefixed by the base path. `_redirects` and `404.html` are not
needed there.

### Cloudflare: create the Worker (once)

The patcher Worker must exist before the website Worker is deployed with its `PATCHER` service binding.

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository** → GitHub → `Blockheads-Club/blockheads-patcher`.
2. **Project name**: `blockheads-patcher-web` (must equal `name` in `wrangler.toml` and the website's `[[services]] service`).
3. **Build command**: `bun run build:worker`
4. **Deploy command**: `npx wrangler deploy`
5. **Non-production branch deploy command** (Settings → Build → Branch control, "Builds for non-production branches"): `npx wrangler versions upload`
6. **Root directory** (Advanced settings → Path): `/` (repo root, where `wrangler.toml` and `bun.lock` are; dependencies are installed with bun automatically).
7. **Production branch**: `dev` (switch to `main` once stable releases exist).
8. **Build variables**: none required. Optional `BASE_PATH=/patcher` (that is the default; it must match the path the website forwards).
9. Do not add a route or custom domain. You may turn off the `workers.dev` URL and preview URLs (Settings → Domains & Routes); the app is reached through blockheads.club/patcher/.

Then deploy the website Worker (its next build picks up the binding). Check https://blockheads.club/patcher/ and a deep
link such as https://blockheads.club/patcher/splash.

Local check of both Workers together (from the website checkout, after building both):

```sh
npx wrangler dev -c wrangler.toml -c ../blockheads-patcher/wrangler.toml   # http://localhost:8787/patcher/
BASE_PATH=/patcher E2E_PORT=8787 bun run --filter @bh-patcher/app test:e2e # app e2e through the website Worker
```

## Releases

Push a signed tag `vX.Y.Z` on `dev` (versions follow `app/package.json`, `app/src-tauri/Cargo.toml` and
`tauri.conf.json`). `release.yml` (on a `v*` tag, or manual with the tag as input) builds every bundle and attaches it to
a **draft** GitHub release for that tag (marked prerelease for `0.x` and `-pre` tags); publish the draft once CI is green.
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

## CI

`ci.yml`: `check` (svelte-check + tsc), `test` (vitest with 100% coverage thresholds, defined in the vitest configs),
`e2e` (Playwright), `clippy` (`-D warnings`), `desktop-check` (`cargo check` on Windows x64/arm64, Linux arm64 and
macOS), `kotlin` (JDK 17 Android compile via a debug build).

## Third-party fonts

Third-party font: the `fix-system-font-crash` patch embeds subsets of Noto Sans Regular, Bold and Italic (Copyright 2022
The Noto Project Authors), licensed under the SIL Open Font License 1.1 (`packages/core/src/patches/fonts/OFL.txt`). They
are free fonts from the Noto Project, not game files; `scripts/fonts/noto-sans-subset.py` regenerates them.
