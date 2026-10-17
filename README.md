# Blockheads Patcher

Open-source (GPL-3.0-only) tool that patches **your own copy** of *The Blockheads* for Android
(`com.noodlecake.blockheads`) to fix bugs and, later, add features. Runs as a static website,
a Windows desktop app and an Android app (Tauri 2). All processing is local; there is no server.

## Legal notice

- This project is **not affiliated with, endorsed by or connected to Majic Jungle Games or Noodlecake Studios.**
  "The Blockheads" is their trademark and software.
- **No game files are distributed or downloaded by this project.** You supply the APK yourself
  (file picker on web/desktop; on Android the app reads the copy already installed on your device).
- Only patch software you legally own. You are responsible for complying with the game's license and the law
  in your country. The output is re-signed with your own key, so it is a different app signature than the original.

## First patch

`fix-welcome-popup-deadlock`: on Android 10+ the game can freeze on the "WELCOME TO <world>!" popup when
joining a multiplayer server (opaque popup Activity stops the game activity, causing a main-thread deadlock).
The patch changes the popup activity theme in `AndroidManifest.xml` to a translucent framework theme.

## Repository layout

| Path | Purpose |
|---|---|
| `packages/core` | Pure TypeScript patch engine (zip, binary XML, APK signing v1+v2, patches, pipeline) |
| `app` | SvelteKit 2 + Svelte 5 static app (web + Tauri webview) |
| `app/src-tauri` | Tauri 2 project (Windows desktop + Android) |
| `plugins/tauri-plugin-apk-tools` | Tauri plugin: Kotlin (Android installed-APK access, uninstall, install) |
| `docs/ARCHITECTURE.md` | Module contracts |

## Build

Prerequisites: [bun](https://bun.sh), Rust stable (rustup). `bun install` at the repo root.

```sh
bun run check      # type checks (all workspaces)
bun run test       # unit tests (all workspaces)
```

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

The app is fully static (no server). Two targets, both built from `app/build`:

| Target | Workflow | Notes |
| --- | --- | --- |
| GitHub Pages (project site, `/blockheads-patcher/`) | `deploy-pages.yml` (push to `dev`/`main`, manual) | Built with `BASE_PATH=/blockheads-patcher`; `.nojekyll` and a `404.html` SPA fallback are emitted. Enable Pages with source "GitHub Actions" and allow the `dev` branch in the `github-pages` environment rules. |
| Cloudflare Pages | `deploy-cloudflare.yml` (push to `dev`/`main`, manual) | Needs secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; skipped (with a notice) when absent. Project name `blockheads-patcher` (`wrangler.toml`). `main` is the production branch, others get preview URLs. |

```sh
bun run --filter @bh-patcher/app build:web                       # root-hosted (Cloudflare, local)
BASE_PATH=/blockheads-patcher bun run --filter @bh-patcher/app build:web   # GitHub Pages
```

`build:web` runs `app/scripts/finalize-web.mjs`, which writes the sha256 of SvelteKit's inline bootstrap script into
`_headers` (strict CSP: no `unsafe-inline` for scripts, `worker-src 'self' blob:`) and creates `404.html`.
`_headers`/`_redirects` only take effect on Cloudflare Pages; GitHub Pages ignores them.

## Releases

Fully automated with [semantic-release](https://semantic-release.gitbook.io) and Conventional Commits
(`.releaserc.json`). `main` publishes stable versions (`v1.0.0`), `dev` publishes the prerelease channel `dev`
(`v1.0.0-dev.N`). Only a git tag and a GitHub release are created; nothing is committed back.

`release.yml` (on push to `main`/`dev` or manual) determines the next version with a dry run, builds, then publishes:

- Windows: NSIS `.exe` + `.msi`; Linux: `.AppImage` + `.deb`; macOS: universal `.dmg` (arm64 + x86_64)
- Android APKs per ABI: `arm64-v8a`, `armeabi-v7a`, `x86_64`. Release-signed when the secrets `ANDROID_KEYSTORE_BASE64`,
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` exist, otherwise debug-signed
- `blockheads-patcher-web-<version>.zip` (static site)

MSI requires numeric prerelease identifiers, so bundle metadata uses `1.0.0-3` for `1.0.0-dev.3` (release tag/asset names keep `dev.N`).
Desktop bundles are unsigned/not notarized unless you add signing secrets. Every workflow has `workflow_dispatch`.

## CI

`ci.yml`: `check` (svelte-check + tsc), `test` (vitest with 100% coverage thresholds, defined in the vitest configs),
`e2e` (Playwright), `clippy` (`-D warnings`), `kotlin` (JDK 17 Android compile via a debug build).

## License

GPL-3.0-only. See `LICENSE`.
