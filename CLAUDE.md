# CLAUDE.md

Project: Blockheads Patcher (see README.md, docs/ARCHITECTURE.md - the contracts there are binding).

## Hard rules
- NEVER commit, copy into the repo, ship or download the game APK. Test APKs live in
  `/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk` (versionName 1.7.4, versionCode 1548230154) and
  `..._1.7.5_APKPure.apk`; tests must `skip` when absent. `*.apk` is gitignored.
- Keep README/UI legal copy: not affiliated with Majic Jungle/Noodlecake; no game files distributed; patch only what you own.
- No server. Everything client-side.

## Conventions
- Package manager: bun (never npm). Workspace root scripts: `bun run check`, `bun run test`.
- TypeScript strict. SvelteKit 2 + Svelte 5 runes, `@sveltejs/adapter-static` (fallback index.html); same app runs on web and in Tauri 2.
- `packages/core` is pure TS: runs in browser + webview; no Node-only APIs in runtime code (tests may use node:fs). WebCrypto for crypto.
- Tests: Vitest (+ @testing-library/svelte), Playwright for e2e. Rust: rustup stable.
- Test tiers: `bun run test:fast` while iterating (unit tests + 1.7.6 real-APK tests, no coverage, NOT a gate);
  `bun run check` and `bun run test:cov` (all versions, 100 % coverage) before every merge into dev.
  Real-APK suites live in `*.suite.ts` with one `*-1.7.x.test.ts` per version; gate new real-APK tests with
  `haveApk(path)` (it honours `BH_REAL_VERSIONS` / `BH_SKIP_REAL`). Compare zip entries with `sameContent`
  (raw bytes first) instead of inflating every entry. If `/tmp` (tmpfs) is full, run with `TMPDIR` elsewhere.
- UI default language English; i18n dictionaries `app/src/lib/i18n/<code>.ts` (en, tr). New language = one new dictionary + register in `index.ts`. Key set must match en (test enforces).
- Code, comments, docs in English. No gold-plating; production quality + tests.
- Android: use JDK 17/21 (`/usr/lib/jvm/java-21-openjdk`), not the default JDK 26.
- Identifiers: bundle `com.blockheadspatcher.app`, productName "Blockheads Patcher", license GPL-3.0-or-later.
- Verify signed output with `~/Android/Sdk/build-tools/35.0.0/apksigner verify --verbose` (v1 and v2 must verify).
