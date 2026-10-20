# Architecture and module contracts

Binding contracts so independent agents can implement in parallel. All code is TypeScript strict,
ES modules, no Node-only APIs in runtime code. Binary data is always `Uint8Array`.
Every directory has an `index.ts` re-exporting its public API; `packages/core/src/index.ts` re-exports all of them.
File ownership (one agent each): **A** zip + axml, **B** signing, **C** patches + pipeline, **D** app UI/adapters, **E** Android plugin.
Core agents must not edit each other's directories; cross-module use only via the signatures below.

Test APK path constant for tests: `/home/kahverengi/Downloads/The Blockheads_1.7.4_APKPure.apk` (use `describe.skipIf(!existsSync(p))`).

---------------------------------------------------------------------------------------------------

## 1. `packages/core/src/zip/` (agent A)

Uses `fflate` (`inflateSync`/`deflateSync`, raw deflate) or own code; must preserve everything except what the caller changes.

```ts
export interface ZipEntry {
  name: string;                  // UTF-8 path, no leading slash; directories end with '/'
  method: 0 | 8;                 // 0 = STORE, 8 = DEFLATE
  data: Uint8Array;              // UNCOMPRESSED content
  /** Present for entries read from a zip: compressed bytes + crc32 to allow copy-through without recompress. */
  raw?: { compressed: Uint8Array; crc32: number; uncompressedSize: number };
  modTime: number;               // DOS time (u16)
  modDate: number;               // DOS date (u16)
  extra?: Uint8Array;            // central-directory-independent local extra field (dropped when aligning)
  comment?: string;
  externalAttrs: number;         // u32, preserved
  versionMadeBy: number;         // u16, preserved
  flags: number;                 // u16 general purpose flags, preserved except bit 3 (data descriptor) is cleared on write
}
export interface ZipArchive {
  entries: ZipEntry[];           // original order
  comment?: Uint8Array;
}
export function readZip(bytes: Uint8Array): ZipArchive;           // throws ZipError on malformed input; handles APK signing block (ignores it)
export function getEntry(zip: ZipArchive, name: string): ZipEntry | undefined;
export function setEntry(zip: ZipArchive, entry: Pick<ZipEntry,'name'|'data'> & Partial<ZipEntry>): void; // replace in place (keeps position & method) or append (default method 8)
export function removeEntry(zip: ZipArchive, name: string): boolean;
export function removeSignatureFiles(zip: ZipArchive): string[];  // drops META-INF/MANIFEST.MF, META-INF/*.SF|RSA|DSA|EC (and META-INF/SIG-*); returns removed names
export interface WriteZipOptions {
  /** Align STORED entries data offset: default 4. Entries named *.so that are STORED use soAlignment (default 4096). */
  alignment?: number; soAlignment?: number;
  /** Unchanged entries (raw present and data not mutated) are copied through without recompression. */
}
export function writeZip(zip: ZipArchive, opts?: WriteZipOptions): Uint8Array;
export class ZipError extends Error {}
export function crc32(data: Uint8Array): number;
/** Offsets needed by signing v2: */
export function locateEocd(bytes: Uint8Array): { eocdOffset: number; cdOffset: number; cdSize: number; entryCount: number };
```
Rules: alignment is achieved by padding the local-header `extra` field (zipalign semantics); DEFLATE entries need no alignment.
Tests: read/write identity of entry contents on the real APK; STORED entries aligned (check `dataOffset % alignment == 0`); `unzip -t`/`apksigner` happy after write.

## 2. `packages/core/src/axml/` (agent A)

Android binary XML (chunks: STRING_POOL 0x0001, XML 0x0003, RESOURCE_MAP 0x0180, START_NS 0x0100, END_NS 0x0101, START_ELEMENT 0x0102, END_ELEMENT 0x0103, CDATA 0x0104). Round-trip of an unmodified file must be **byte-identical** (preserve pool encoding UTF-8/UTF-16, style spans, string order, flags, unused strings, line numbers/comment indices).

```ts
export const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
export const enum ValueType { Null = 0x00, Reference = 0x01, Attribute = 0x02, String = 0x03, Float = 0x04, Dimension = 0x05,
  Fraction = 0x06, IntDec = 0x10, IntHex = 0x11, IntBoolean = 0x12, IntColorArgb8 = 0x1c, IntColorRgb8 = 0x1d, IntColorArgb4 = 0x1e, IntColorRgb4 = 0x1f }
export interface AxmlAttribute {
  nsUri: string | null;          // resolved namespace URI (null = none)
  name: string;                  // local name, e.g. 'theme'
  resourceId: number | null;     // from resource map (e.g. 0x01010000 for android:theme), null if none
  rawValue: string | null;       // raw string if present (string index != -1)
  valueType: ValueType;          // typed value dataType
  data: number;                  // u32 typed value data (for String type: index into pool, maintained by the serializer)
  /** Convenience: decoded string for ValueType.String, else undefined */
  stringValue?: string;
}
export interface AxmlElement { name: string; nsUri: string | null; attributes: AxmlAttribute[]; children: AxmlElement[]; lineNumber: number; }
export interface AxmlDocument {
  root: AxmlElement;
  // opaque internal state (pool, resource map, namespaces, comments) lives in private fields
}
export function parseAxml(bytes: Uint8Array): AxmlDocument;      // throws AxmlError
export function serializeAxml(doc: AxmlDocument): Uint8Array;    // identity for unmodified docs
export function findElements(doc: AxmlDocument, predicate: (e: AxmlElement, path: string[]) => boolean): AxmlElement[];
export function getAttr(el: AxmlElement, name: string, nsUri?: string | null, resourceId?: number): AxmlAttribute | undefined;
/** Matches by resourceId when given, else by (nsUri,name). */
export function setAttrValue(doc: AxmlDocument, attr: AxmlAttribute, valueType: ValueType, data: number): void;
export function setAttrString(doc: AxmlDocument, attr: AxmlAttribute, value: string): void; // adds to pool if needed
export function addAttr(doc: AxmlDocument, el: AxmlElement, a: Omit<AxmlAttribute,'stringValue'>): AxmlAttribute; // keeps attributes sorted by resourceId (Android requirement), updates pool/resource map
export function manifestInfo(doc: AxmlDocument): { package: string; versionName?: string; versionCode?: number; /* android:versionCode int */ };
export class AxmlError extends Error {}
```
Tests: parse + serialize identity on AndroidManifest.xml of the 1.7.4 APK; changing `android:theme` of the BlockheadsWebView activity changes only the 4 data bytes (+ valueType if different); `aapt2 dump xmlstrings`/`aapt dump badging` from `~/Android/Sdk/build-tools/35.0.0` accept the result.

## 3. `packages/core/src/signing/` (agent B)

```ts
// --- DER / ASN.1 minimal encoder (signing/asn1.ts) ---
export const der: {
  seq(...c: Uint8Array[]): Uint8Array; set(...c: Uint8Array[]): Uint8Array; int(v: bigint | Uint8Array): Uint8Array;
  oid(dotted: string): Uint8Array; octets(b: Uint8Array): Uint8Array; utf8(s: string): Uint8Array; printable(s: string): Uint8Array;
  utcTime(d: Date): Uint8Array; bitString(b: Uint8Array): Uint8Array; nul(): Uint8Array; ctx(tag: number, c: Uint8Array, constructed?: boolean): Uint8Array;
  bool(v: boolean): Uint8Array; concat(...b: Uint8Array[]): Uint8Array;
};

// --- Identity ---
export interface SigningIdentity {
  privateKey: CryptoKey;          // RSASSA-PKCS1-v1_5 / SHA-256, extractable: true (so it can be exported)
  publicKey: CryptoKey;
  certificateDer: Uint8Array;     // self-signed X.509 v3, RSA-2048
}
export function generateIdentity(opts?: { commonName?: string; validityYears?: number /* default 30 */; now?: Date }): Promise<SigningIdentity>;
export interface IdentityBundle { version: 1; pkcs8: string /* base64 */; certificate: string /* base64 DER */; }
export function exportIdentity(id: SigningIdentity): Promise<IdentityBundle>;   // JSON-serializable; also exportIdentityJson(id): Promise<string>
export function importIdentity(b: IdentityBundle | string): Promise<SigningIdentity>; // validates key matches cert public key; throws SigningError
// Optional if feasible (bonus, not required): exportPkcs12/importPkcs12.

// --- Keystore abstraction (signing/keystore.ts) ---
export interface Keystore {
  get(): Promise<SigningIdentity | null>;
  set(id: SigningIdentity): Promise<void>;
  clear(): Promise<void>;
}
export class MemoryKeystore implements Keystore {}
/** IndexedDB, db 'bh-patcher', store 'keys', single record 'signing-identity'; CryptoKeys stored directly (structured clone). Accepts injected IDBFactory for tests (fake-indexeddb as devDependency). */
export class IndexedDbKeystore implements Keystore { constructor(factory?: IDBFactory) }
export function getOrCreateIdentity(ks: Keystore): Promise<SigningIdentity>; // load or generate+persist

// --- Signing (signing/sign.ts) ---
export interface SignOptions { identity: SigningIdentity; createdBy?: string /* default 'Blockheads Patcher' */; minSdk?: number; }
/**
 * Input: zip bytes already containing NO signature files (caller or this function calls removeSignatureFiles).
 * Output: aligned APK signed with v1 (META-INF/MANIFEST.MF, BHPATCH.SF, BHPATCH.RSA; SHA-256 digests, CERT PKCS#7 SignedData, SHA256withRSA)
 * and v2 (APK Signing Block 0x7109871a before the central directory, signer with algorithm 0x0103 RSASSA-PKCS1-v1_5 SHA-256,
 * chunked 1 MiB digests over sections 1-3, EOCD cd-offset field rewritten for the digest per spec).
 * Uses zip module: readZip -> removeSignatureFiles -> add v1 files -> writeZip (aligned) -> insert v2 block.
 */
export function signApk(apk: Uint8Array, opts: SignOptions): Promise<Uint8Array>;
export function v1Files(zip: ZipArchive, opts: SignOptions): Promise<{ manifest: Uint8Array; sf: Uint8Array; rsa: Uint8Array }>;
export function buildV2Block(zipWithoutBlock: Uint8Array, opts: SignOptions): Promise<Uint8Array>; // returns whole APK with block inserted
export class SigningError extends Error {}
```
Acceptance: `apksigner verify --verbose --print-certs out.apk` reports `Verified using v1 scheme (JAR signing): true`, `v2 scheme: true`; re-signing an already-patched APK works; second patch with the same keystore identity yields the same cert SHA-256 (updatable install). Gotcha: v1 manifest line wrapping at 72 bytes; section names for each non-directory entry except META-INF signature files; store `X-Android-APK-Signed: 2` in SF when v2 present.

## 4. `packages/core/src/patches/` (agent C)

```ts
export interface ApkInfo { packageName: string; versionName?: string; versionCode?: number; sha256: string /* hex of input file */; }
export type PatchStatus = 'applied' | 'notApplied' | 'incompatible';
export interface PatchAppliesTo {
  packageName: string;
  versionCode?: { min?: number; max?: number };
  versionNames?: string[];        // optional exact allow-list
  sha256?: string[];              // known-good input hashes (informational; not required to apply)
}
/** Mutable working copy handed to patches; a patch edits it, pipeline serializes. */
export interface PatchContext {
  zip: ZipArchive;
  manifest: AxmlDocument;         // parsed AndroidManifest.xml; pipeline re-serializes it into the zip if `manifestDirty`
  info: ApkInfo;
  markManifestDirty(): void;
  log(msg: string): void;
}
export interface Patch {
  id: string;                     // kebab-case, stable
  version: number;                // patch revision, integer
  nameKey: string;                // i18n key (app dictionaries), e.g. 'patch.fix-welcome-popup-deadlock.name'
  descriptionKey: string;         // i18n key
  appliesTo: PatchAppliesTo;
  detect(ctx: PatchContext): PatchStatus;      // pure, no mutation
  apply(ctx: PatchContext): void;              // throws PatchError if detect() !== 'notApplied'
}
export class PatchError extends Error {}
export interface PatchRegistry {
  register(p: Patch): void; get(id: string): Patch | undefined; list(): Patch[];
}
export function createRegistry(patches?: Patch[]): PatchRegistry;
export const defaultRegistry: PatchRegistry;                   // contains builtin patches
export const fixWelcomePopupDeadlock: Patch;                   // patches/fix-welcome-popup-deadlock.ts
export const ANDROID_THEME_ATTR_ID = 0x01010000;
export const THEME_TRANSLUCENT_NO_TITLE_BAR_FULLSCREEN = 0x01030011;
```
`fix-welcome-popup-deadlock`: find `<activity>` whose `android:name` string equals `com.noodlecake.noodlewebview.BlockheadsWebView` (also accept relative `.noodlewebview...` forms resolved against package); `detect`: element missing -> `incompatible`; theme attr missing or other value -> `notApplied`; attr is Reference 0x01030011 -> `applied`. `apply`: `setAttrValue(doc, attr, ValueType.Reference, 0x01030011)` (if attr missing, `addAttr` with resourceId 0x01010000). No `resources.arsc` change. i18n keys to add in app dictionaries: `patch.fix-welcome-popup-deadlock.name|description`.

## 5. `packages/core/src/pipeline.ts` (agent C)

```ts
export interface LoadedApk { zip: ZipArchive; manifest: AxmlDocument; info: ApkInfo; }
export type ApplicableReport = { patch: Patch; status: PatchStatus; reason?: string }[];
export type Progress = (stage: 'read' | 'parse' | 'patch' | 'write' | 'sign' | 'done', fraction: number) => void;
export function loadApk(bytes: Uint8Array): Promise<LoadedApk>;                   // computes sha256 with crypto.subtle; throws PatchError('not an APK' / 'no manifest')
export function listPatches(apk: LoadedApk, registry?: PatchRegistry): ApplicableReport; // honours appliesTo (package, versionCode range, versionNames) -> 'incompatible' if outside, else patch.detect
export function applyPatches(apk: LoadedApk, patchIds: string[], registry?: PatchRegistry): { applied: string[]; skipped: { id: string; status: PatchStatus }[] };
export interface PatchApkOptions { patchIds: string[]; keystore: Keystore; registry?: PatchRegistry; onProgress?: Progress; }
export interface PatchApkResult { bytes: Uint8Array; applied: string[]; skipped: { id: string; status: PatchStatus }[]; info: ApkInfo; certSha256: string; suggestedFileName: string /* e.g. 'blockheads-1.7.4-patched.apk' */; }
/** Full flow: loadApk -> applyPatches -> serialize manifest into zip -> removeSignatureFiles -> signApk(keystore identity via getOrCreateIdentity). */
export function patchApk(input: Uint8Array, opts: PatchApkOptions): Promise<PatchApkResult>;
```
Tests (skip if APK missing): detect on 1.7.4 = notApplied; after apply = applied and a second `apply` throws; full patchApk output is verified with `apksigner verify` via child_process in the test; unrelated entries byte-identical in content.

---------------------------------------------------------------------------------------------------

## 6. App (`app/`, agent D)

Routes: single page `src/routes/+page.svelte` (static SPA, `ssr=false`). Svelte 5 runes only. i18n: `import { t, lang, setLanguage, languageNames } from '$lib/i18n'`; `$t('key', {param})`; dictionaries `en.ts` (source of truth, `as const`), `tr.ts`, `ru.ts`, `kk.ts` (`Record<MessageKey,string>`) - adding a language = new file + entry in `dictionaries` and `languageNames` (native name). Plurals use ICU syntax inside a message, `{n, plural, one {# fix} few {…} many {…} other {# fixes}}` (`=N` branches allowed; categories from `Intl.PluralRules`, `#` is the locale-formatted number); every plural needs `other`, and the test enforces the locale's own categories. Language auto-detected from `navigator.languages`, persisted in localStorage `bhp.lang`.

Platform adapter (`src/lib/platform/types.ts`):
```ts
export type PlatformKind = 'web' | 'tauri-desktop' | 'tauri-android';
export interface PickedApk { name: string; bytes: Uint8Array; source: 'file' | 'installed'; }
export interface InstalledGameInfo { packageName: string; versionName?: string; versionCode?: number; splitSourceDirs: string[]; }
export interface PlatformAdapter {
  kind: PlatformKind;
  pickApk(): Promise<PickedApk | null>;                              // file picker (input[type=file] / tauri dialog+fs); null if cancelled
  saveOutput(name: string, bytes: Uint8Array): Promise<{ location?: string }>; // web: Blob download; desktop: save dialog + fs write; android: write to app cache then share/save dialog
  // Android only (undefined elsewhere):
  getInstalledGame?(): Promise<InstalledGameInfo | null>;           // null if not installed
  loadInstalledApk?(): Promise<PickedApk>;                          // reads base.apk of installed game (via plugin: copy to cache, read via plugin-fs)
  uninstallOriginal?(): Promise<{ started: boolean }>;              // ACTION_DELETE; signatures differ so original must be removed before installing
  installApk?(name: string, bytes: Uint8Array): Promise<{ started: boolean }>;
  canRequestInstalls?(): Promise<boolean>; openInstallSettings?(): Promise<void>;
}
export function getPlatform(): PlatformAdapter;   // detects window.__TAURI_INTERNALS__ + userAgent Android; files web.ts, tauri-desktop.ts, tauri-android.ts, index.ts
```
Components (`src/lib/components/`): `LegalNotice.svelte` (always visible, uses `legal.notice`), `LanguageSelect.svelte`, `ApkPicker.svelte` (props: `platform`, `onpicked(p: PickedApk)`), `PatchList.svelte` (props: `report: ApplicableReport`, `selected: string[]` bindable; shows status badges), `ProgressBar.svelte`, `KeyManager.svelte` (export/import identity JSON via `exportIdentityJson`/`importIdentity`, regenerate), `ResultPanel.svelte` (save / install / uninstall-original buttons based on adapter capabilities, explains signature mismatch). State store `src/lib/state.svelte.ts` with `$state` class `PatcherState` (stages: idle -> loaded -> patching -> done | error). Keystore: `new IndexedDbKeystore()`. Heavy work runs on main thread with `await` yields (a Web Worker is optional later). Tests: component tests with @testing-library/svelte (mock adapter), i18n key parity, one Playwright e2e with a synthetic fixture generated in-test (never the real APK).
Required i18n keys (minimum, add as needed): `app.title`, `legal.notice`, `picker.choose`, `picker.useInstalled`, `patches.title`, `status.applied|notApplied|incompatible`, `action.patch`, `result.save`, `result.uninstall`, `result.install`, `keys.title|export|import|regenerate`, `error.generic`, `patch.fix-welcome-popup-deadlock.name|description`.

## 7. Tauri (`app/src-tauri/`)
Identifier `com.blockheadspatcher.app`; plugins: dialog, fs, apk-tools. fs scope must allow reading/writing `$APPCACHE/**` and `$DOWNLOAD/**` plus user-picked paths (dialog extends scope). Android Gradle needs JDK 17/21. Manifest additions (Android agent, via `gen/android` template or plugin manifest merge): `<queries><package android:name="com.noodlecake.blockheads"/></queries>`, `REQUEST_DELETE_PACKAGES`, `REQUEST_INSTALL_PACKAGES`, FileProvider authority `${applicationId}.apkfileprovider` with `file_paths.xml` exposing cache dir.

## 8. Kotlin plugin contract (`plugins/tauri-plugin-apk-tools`, agent E)

Plugin name `apk-tools`, Kotlin class `com.blockheadspatcher.apktools.ApkToolsPlugin` (`@TauriPlugin`). JS invoke: `invoke('plugin:apk-tools|<command>', args)`. Large data NEVER crosses the IPC as JSON: Kotlin works with files in `context.cacheDir/bhp/` and returns absolute paths; JS reads/writes them with `@tauri-apps/plugin-fs`. Non-Android platforms: all commands reject with `"unsupported"`. Command names below are logical snake_case; agent E verifies the exact Kotlin-method/`COMMANDS` naming rule of Tauri 2 mobile plugins and keeps `build.rs`, `permissions/default.toml` and `guest-js` consistent.

| command | args | returns | behavior |
|---|---|---|---|
| `get_installed_package` | `{ packageName: string }` | `{ installed: false } \| { installed: true, packageName, versionName?: string, versionCode: number (long), sourceDir: string, splitSourceDirs: string[] }` | `PackageManager.getPackageInfo` (needs `<queries>`); sourceDir = `applicationInfo.sourceDir` |
| `read_installed_apk` | `{ packageName: string }` | `{ path: string, size: number, splitSourceDirs: string[] }` | copy `sourceDir` to `cacheDir/bhp/<pkg>-base.apk`; reject `"not_installed"` |
| `request_uninstall` | `{ packageName: string }` | `{ started: boolean }` | `ACTION_DELETE` intent `package:<pkg>` with `EXTRA_RETURN_RESULT`; resolves after activity result (`started:true` if the dialog was shown); needs `REQUEST_DELETE_PACKAGES` |
| `can_request_installs` | `{}` | `{ allowed: boolean }` | `packageManager.canRequestPackageInstalls()` |
| `open_install_settings` | `{}` | `{}` | `ACTION_MANAGE_UNKNOWN_APP_SOURCES` for own package |
| `install_apk` | `{ path: string }` (file inside cacheDir/bhp) | `{ started: boolean }` | PackageInstaller session (write file, commit with PendingIntent, launch the confirm intent from `STATUS_PENDING_USER_ACTION`) ; fallback FileProvider + `ACTION_VIEW`. Rejects `"permission_denied"` if installs not allowed; `"invalid_path"` if outside cacheDir |

Errors are strings (`unsupported`, `not_installed`, `permission_denied`, `invalid_path`, `io_error: <msg>`). Guest bindings in `guest-js/index.ts` export typed wrappers: `getInstalledPackage(pkg)`, `readInstalledApk(pkg)`, `requestUninstall(pkg)`, `canRequestInstalls()`, `openInstallSettings()`, `installApk(path)`; the cache dir for JS fs access is obtained via `appCacheDir()` from `@tauri-apps/api/path` + `bhp/`.
