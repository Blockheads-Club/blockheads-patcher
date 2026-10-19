# Patch packs (`.bhpack`)

A patch pack adds patches to the Patcher without changing the Patcher itself, for example patches you keep for
yourself or share with a few people. Packs are **declarative**: a pack is data (a JSON description plus payload files)
that the Patcher interprets with the same checked building blocks its built-in patches use. The Patcher never runs code
from a pack.

What a pack can change is still the game: it can rename the app, add files, patch the native library or add Java
classes to the game. Import packs only from people you trust. The app says so next to the import button.

## In the app

*Settings → Imported patch packs*: **Import pack** (file picker; you can also drop a `.bhpack` on the section on the web
and anywhere on the window in the desktop app). Each pack shows its name, version, author and number of patches, and can
be removed. A pack with the same `id` as an imported one replaces it.

Imported patches appear in the patch list after the built-in ones, with a **Pack** badge. They are never ticked by
default. When two imported patches write the same thing, Settings lists them; if you tick both, the one listed later
wins (patches always run in list order).

Imported packs are stored on the device:

| Platform | Where |
| --- | --- |
| Web | IndexedDB of the site (`bhp-packs`) |
| Desktop (Windows, Linux, macOS) | `<app data>/packs/<id>.bhpack` |
| Android | app-private storage, `<app data>/packs/<id>.bhpack` |

A stored pack that a later Patcher version no longer accepts is listed as unreadable and can be removed.

## Format

A `.bhpack` is a zip file with `pack.json` at its root and the payload files the operations refer to. Every file in
the zip must be used by an operation; directories are ignored. The full JSON Schema is
[`pack.schema.json`](pack.schema.json) (a test keeps it identical to the one the Patcher validates with).

```text
my-pack.bhpack
├── pack.json
└── files/
    └── hello.txt
```

### `pack.json`

| Field | | |
| --- | --- | --- |
| `schemaVersion` | required | `1` |
| `id` | required | `[a-z0-9._-]`, 1–48 characters, starts and ends with a letter or digit; patch ids become `pack:<id>/<patchId>` |
| `version` | required | `major.minor.patch` |
| `name` | required | texts by language code, `en` required (`{ "en": "…", "tr": "…" }`) |
| `description`, `author` | optional | |
| `minPatcherVersion` | optional | the pack is refused by older Patchers |
| `appliesTo` | required | `packageName`, optional `versionNames`, `versionCodes` (exact list), `sha256` (exact list of APK file hashes) |
| `patches` | required | 1–64 patches |

Each patch has `id`, `name`, `description`, optional `summary` (short line in the list; defaults to the description),
optional `appliesTo` (replaces the pack's) and `ops`, 1–256 operations applied in order. Texts fall back to English for
languages a pack does not translate.

A patch is *applied* when all its operations are already in effect, *not applied* when each of them is either in
effect or can be done, and *not for this version* when any operation does not fit the APK (missing file, unexpected
bytes, wrong version, ...). Nothing is written unless every operation fits. Applying skips the operations that are
already in effect.

### Operations

| `op` | Fields | Notes |
| --- | --- | --- |
| `manifest.set` | `target`, `attr`, `value` | `target` is `"application"` or `{ "activity": "<fully qualified class>" }` (top-level activities). Allowed `attr`: `label` (string), `theme` (platform style id `0x01xxxxxx`), `launchMode`, `screenOrientation` (integer, activity), `configChanges`, `windowSoftInputMode` (flags, activity), `allowBackup`, `largeHeap`, `usesCleartextTraffic`, `hasFragileUserData`, `allowAudioPlaybackCapture`, `requestLegacyExternalStorage` (boolean, application), `immersive` (boolean, activity), `hardwareAccelerated`, `resizeableActivity` (boolean). Permissions, components, the package name and code loading cannot be changed. |
| `manifest.remove` | `target`, `attr` | same attributes |
| `file.add` | `path`, `from` | new file under `assets/` or `res/raw/`; refused when the file exists with other content |
| `file.replace` | `path`, `from`, `expectSha256`? | existing file under `assets/` or `res/raw/`; with `expectSha256` only that version |
| `plist.set` | `path`, `key`, `value` | top-level key of an XML property list (such as `assets/Info.plist`), string / boolean / integer; added when missing |
| `plist.arrayInsert` | `path`, `key`, `value` | appends a string to the top-level array `key`, once |
| `text.replace` | `path`, `find`, `replace` | UTF-8 text file; `find` must occur exactly once (`replace` must not contain it) |
| `native.patch` | `lib`, `locate`, `expect`, `replace`, `libSha256`? | `lib/<abi>/<name>.so`. `locate` is one of `{ "symbol": "name", "add": n }` (ELF `.dynsym`/`.symtab`), `{ "objcMethod": "-[Class selector:]", "add": n }` (classes in `__objc_classlist`, 32-bit Objective-C ABI), `{ "vaddr": n }` or `{ "fileOffset": n }`. `expect` and `replace` are hex bytes of the same length (up to 4096); the current bytes must equal `expect`. `libSha256` pins the unpatched library. |
| `dex.add` | `from` | a prebuilt `.dex` added as the next `classesN.dex`. It must validate, define at least one class, none of which may exist in the APK or live under `java/`, `javax/`, `android/`, `androidx/`, `dalvik/`, `kotlin/`, `sun/`, `libcore/`, `org/apache/harmony/`, `com/android/`, `com/google/android/` or the Patcher's own `com/blockheadsclub/patch/`. |
| `dex.hook` | `class`, `method`, `params`?, `returns`?, `at`?, `call` | inserts a call at the start (`at: "start"`, the only position) of an existing method, e.g. `Lcom/example/Cls;->onStart()V` or `->onStart(Lthe/Hooked/Class;)V` to pass the instance (`this`, or `Ljava/lang/Object;`). The target must be a static method of a class added by an earlier `dex.add` of the same patch. Constructors cannot be hooked. |

Paths are checked twice: by the schema (only `assets/` and `res/raw/`; `lib/`, `META-INF/`, `classes*.dex` and anything
with `..` are refused) and by the archive reader (zip entry names must be plain relative paths).

Within one patch, two operations may not write the same thing (the same file, manifest attribute or property-list key).

### Limits

| | |
| --- | --- |
| pack file | 64 MiB |
| files in the pack | 512 |
| one file, unpacked | 32 MiB |
| all files, unpacked | 128 MiB |
| `pack.json` | 256 KiB |
| patches / operations per patch | 64 / 256 |

## Example

[`examples/packs/example-label`](../examples/packs/example-label) is a harmless pack with two patches: one renames the
app (`manifest.set` of `label`), the other adds `assets/patch-pack-example.txt`.

```sh
bun scripts/build-pack.ts examples/packs/example-label            # -> example-label-1.0.0.bhpack
bun scripts/build-pack.ts path/to/my-pack my-pack.bhpack
```

The script zips the folder deterministically (same input, same bytes) and validates the result exactly like the app
does on import; it writes nothing and exits non-zero when the pack would be refused.

## For developers

`@bh-patcher/core` exports `loadPack(bytes)` (returns `{ ok: true, pack }` or `{ ok: false, errors }` with a code, a
JSON pointer or file path and a message per problem), `registryWithPacks(packs)` (built-in patches followed by the packs'
patches, plus write conflicts between pack patches), `buildPackArchive(files)` and `PACK_SCHEMA`. Pack patches are
ordinary `Patch` objects with `optIn: true`, their own `texts` and `source: { kind: 'pack', ... }`, so `listPatches`
and `patchApk` take them through the `registry` option.
