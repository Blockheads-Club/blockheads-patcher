- zip: packages/core/src/index.ts should add `export * from './zip';` (not edited by zip agent). Entry copy-through is detected via crc32 of data vs raw.crc32 plus a WeakMap of the original method; replace via setEntry or assign entry.data.

## axml (agent A)
- `manifestInfo` also returns `minSdk` and `targetSdk` (optional numbers); superset of the contract.
- Extra exports: `findElementsByName(doc, tag, androidName)`, `ManifestInfo` type.
- `addAttr` with `ValueType.String`: `rawValue` is required and interned; the `data` argument is ignored (the pool index is computed).
- `findElements` predicate `path` includes the element itself as last item (e.g. `['manifest','application','activity']`).
- The real 1.7.4 manifest contains CDATA nodes inside elements; they are preserved (not exposed publicly).
- `packages/core/src/index.ts` should add `export * from './axml';` (not my file).

## signing (agent B)
- `SignOptions.minSdk`: if omitted, `signApk` auto-detects it from AndroidManifest.xml (`uses-sdk`, via axml `parseAxml`). minSdk < 18 (the real 1.7.4 APK has minSdk 12) makes v1 use SHA-1 digests/SHA-1 signature (SHA-256 JAR signatures are rejected by apksigner for API 12-17); otherwise SHA-256. v2 is always SHA-256.
- `signApk` throws SigningError-free on re-sign: it strips old signature files; `buildV2Block` rejects input that already has a signing block.
- `packages/core/src/index.ts` should add `export * from './signing';` (not edited by signing agent).
- Added devDependency `fake-indexeddb` to packages/core.

## ui (agent D)
- UI imports ONLY from `@bh-patcher/core` via `app/src/lib/engine.ts`: `loadApk, listPatches, patchApk, IndexedDbKeystore, generateIdentity, exportIdentityJson, importIdentity` and types `LoadedApk, ApplicableReport, PatchApkOptions, PatchApkResult, Keystore, SigningIdentity`. `packages/core/src/index.ts` must re-export `./zip ./axml ./signing ./patches ./pipeline` for the app to build.
- `PatchApkOptions.onProgress` is passed by the UI; `PatchApkResult.certSha256` is displayed as given (hex, any separator).
- Platform adapters for Tauri (`tauri-*.ts`, `tauri-common.ts`) were written by the Tauri/Android agent; ui only fixed the import names in `platform/index.ts`.
- e2e (`app/tests/e2e/patch-flow.spec.ts`) needs the full core integrated (pipeline) and `bun run build`; fixture is generated in `tests/e2e/fixture.ts` (validated with core axml parse/serialize round-trip).

## platform (Tauri) notes
- Frontend `bun run build` currently fails on `IndexedDbKeystore` etc. missing from `@bh-patcher/core` (owned by other modules); Android build was verified with a stub frontendDist override.
- `app/src/lib/platform/types.ts`, `web.ts`, `index.ts` belong to agent D; `tauri-desktop.ts` exports `createTauriDesktopAdapter()`, `tauri-android.ts` exports `createTauriAndroidAdapter()` (index.ts should call these).
- Plugin Rust commands take snake_case args (`package_name`) which Tauri maps to camelCase `packageName` from JS; `request_uninstall` additionally returns `completed`.
- Release signing for Android: `app/src-tauri/gen/android/keystore.properties` (gitignored) is read by gen/android/app/build.gradle.kts.
- Android builds need JDK 17/21: `JAVA_HOME=/usr/lib/jvm/java-21-openjdk` (JDK 26 not used).
