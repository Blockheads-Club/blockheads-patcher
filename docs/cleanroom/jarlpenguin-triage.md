# Triage of the JarlPenguin/blockheads-android-patches bug list

Credit line used in the app, README and patch metadata:

> Bug list and ideas from JarlPenguin/blockheads-android-patches; implemented independently by Blockheads Club.

## Clean-room process statement

The upstream project has no licence. We therefore used it for **one thing only**: the public, functional list of bugs and
features (a list of ideas, 16 items). Nobody working on this triage opened, fetched, cloned, searched or read that
repository or any copy of its patch files. Every finding below comes from our own analysis of the user-owned game APKs
(1.7.4 / 1.7.5 / 1.7.6): the binary manifest, `resources.arsc`, the three dex files (disassembled locally with the Android
SDK `dexdump`, outputs kept outside the repository), strings of `libApplication.so`, and the Android platform
documentation. No game files, decompiled code or screenshots are stored in this repository. Class and method names below
are references to our own findings, not copied code.

## Facts about the three APKs that drive the triage

* Same package `com.noodlecake.blockheads`; versionCodes 1548230154 (1.7.4), 1557164436 (1.7.5), 1564553369 (1.7.6).
  Manifests are identical apart from version numbers, the welcome web-view theme resource id and renamed Unity-ads
  activities (1.7.6). minSdk 12, **targetSdk 27**, `sharedUserId` set, `VerdeActivity` is the only launcher activity
  (`screenOrientation=portrait` in the manifest, `configChanges` covers orientation/screen size).
* Three dex files (`classes.dex` holds `com.apportable.activity.VerdeActivity` and the audio / lifecycle glue,
  `classes2.dex` ad SDKs, `classes3.dex` UI, web view and permission helper classes). No android `Application` hooks to patch
  other than `VerdeApplication`. All game logic is Objective-C compiled to `libApplication.so` (ARMv7, differs between all
  three versions; hash-pinned native patches are needed per version, as for fix-iap-store-font-crash).
* Resources: `drawable/icon` has PNG-only density variants; no `mipmap`, no `anydpi` configuration.
* Existing patches: `fix-welcome-popup-deadlock` (manifest theme of the web-view activity), `fix-iap-store-font-crash`
  (native, 1.7.6 only).

## New core capabilities, in the order they unlock the most items

| Capability | Needed by items |
| --- | --- |
| A. Manifest element insertion/removal (add/remove `<intent-filter>`, `<data>`, `<uses-library>`, `<queries>`) | 7 |
| B. Resource table (`resources.arsc`) reader/writer: add configs and files to existing resources, edit strings | 1, 6 (splash, tablet layout), partly 9 |
| C. Adding / replacing zip entries and binary XML generation (zip + AXML builder exist; generating new AXML documents is new) | 1 |
| D. DEX layer: parse, edit smali-level instructions (patch a method body, redirect a call), rebuild checksums/signature, add a small helper class | 2, 4, 6, 9, 14, 15?, 16? |
| E. Native patching beyond fixed-word stubs (ARM thumb/arm instruction patching, code caves, string replacement with length limits) per version | 8, 10, 11, 12, 13, 15, 16, 9 (typo) |

## Per-item triage

Legend: fix location M = manifest/resources only, J = Java/dex, N = native `.so`. Difficulty and risk are 1 (low) to 5 (high).
"Same on all versions" means the same approach applies, but native addresses must be re-derived per version.

| # | Item | Location (1.7.4 / 1.7.5 / 1.7.6) | Diff | Risk | Overlap with existing patches | Core capability | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Adaptive icon | M (needs resource table): add `mipmap-anydpi-v26` XML plus foreground/background resources and point `android:icon` / `roundIcon` at them; PNG fallback for < API 26 must stay. Same on all versions. | 3 | 2 | none | B, C | deferred |
| 2 | Music resume / menu loop / start while other app plays | J + N. Java side has an audio manager service (`AndroidAudioManager`, `AudioManagerService`) with a permanent audio-focus request and listener; playback itself is OpenAL/AudioToolbox in native libs. Resume-after-background needs lifecycle hooks (Java `onPause/onResume` -> native) and probably native player state. Same on all versions. | 4 | 3 | none | D, E | later |
| 3a | Game audio capturable by screen recorders | M. `android:allowAudioPlaybackCapture` on `<application>` (API 29 attribute, ignored below). Capture also requires the game's audio usage to be media/game; the OpenAL layer plays through standard streams. | 1 | 1 | none | none | **implemented** (`enable-audio-capture`) |
| 3b | Data lost on uninstall | M. `android:hasFragileUserData` on `<application>` (API 29): Android asks whether to keep data on uninstall. This is an offer shown by Android, the user decides. | 1 | 1 | none | none | **implemented** (`keep-data-on-uninstall`) |
| 4 | Freezes on suspend/resume, web view pages, photo picker | J + M. The welcome-popup freeze is the opaque `BlockheadsWebView` activity stopping the game activity (render thread vs main thread deadlock); already fixed by theme. Other web pages use `com.apportable.ui.WebView` / `WebDialog` (view-based, not activities) and the photo picker goes through `onActivityResult` -> `nativeOnActivityResult`; the suspend/resume freeze is in the Java `Lifecycle` / `VerdeActivity.onPause/onResume` -> native pause path. Needs dex edits and device debugging. | 5 | 4 | **partly done** by fix-welcome-popup-deadlock | D (+ device logs) | later |
| 5 | "Built for an older Android" warning | M. `uses-sdk targetSdkVersion` (27 now). The warning threshold rises with each Android release and we could not confirm exact numbers from documentation (Android 14 only blocks installs below 23). See the targetSdk analysis below. | 2 | 3 | none | none | **implemented, opt-in** (`raise-target-sdk`) |
| 6a | Tablets use iPad layout, splash by device/resolution/orientation | J + N + M. `apportable.splash_screen_type=letterbox` meta-data, `SplashScreen` class and `Device`/`getSplashScreenWidth/Height` in Java feed native layout decisions (device idiom is probably decided in native code; not yet traced). | 4 | 3 | none | B, D, E | later |
| 6b | Native landscape launch, brief right-landscape flash, tilt with auto-rotate off | M + J. Manifest says portrait; the game switches to landscape at runtime through `_setRequestedOrientation` (maps to constants 0/8 depending on API level). A manifest orientation of `sensorLandscape`/`userLandscape` removes the portrait start but changes how auto-rotate and the accelerometer-based tilt interact; the tilt code lives in `Accelerometer`/`MotionManager`/`ApportableOrientationEventListener`. Needs a device to verify. | 3 | 4 | none | M only for the launch part, D for tilt | later (needs device) |
| 6c | Crashes on rotation | J. Activity `configChanges` is broad (0x40000fff) so the crash is in game code (surface/context re-creation), not the manifest. | 4 | 4 | none | D (+ crash logs) | later |
| 6d | Multi-window breaks UI | M. Game activity is resizable by default for modern targets; `android:resizeableActivity="false"` opts out. On very large screens the OS may still letterbox. | 1 | 1 | none | none | **implemented** (`disable-multi-window`) |
| 6e | Native dialog orientation | J. Native dialogs are `com.apportable.ui.AlertView` / `Window.getKeyWindowDialog`; their orientation comes from the activity request. | 4 | 3 | related to 6b | D | later |
| 7 | Join links (`blockheads://`, `theblockheads.net/join.php`) | M + J (+ maybe N). Our finding: the two VIEW intent filters on `VerdeActivity` are malformed (the scheme value is the string `theblockheads.net/join`, which is not a valid scheme; the http filter has no path restriction and contains a stray text node), so the OS never routes the links. The Java glue (`nativeHandleUri`) and native `openURL:` handling exist, and native code builds `join.php?id=..&name=..` URLs. Fix is to replace the filters with correct ones; whether native parsing accepts the resulting data string needs a device test. | 3 | 3 | none | A | **implemented** (`fix-join-links`; device test pending) |
| 8 | LAN hosting / discovery disabled | N. Native `JoinWorldUI` has LAN world UI (`joinLanWorldButtonTapped`, `advancedLocalNetworkButton`); the gating is a native platform check. Per-version addresses. | 5 | 3 | none | E | later |
| 9 | Join links cut off in e-mail, typo in body | J + N. E-mail goes through `VerdeActivity.sendEmail` -> chooser; the body is delivered as an HTML string converted with `Html.fromHtml` to a `Spanned` (link text/formatting is lost or cut in many mail apps). The typo is in a native string table. | 3 | 2 | none | D (body as plain/HTML-safe text), E (typo) | later |
| 10 | Storage permission never shown on Android 7.1+ | N (not manifest). The Java helper `NoodlePermissionGranter` behaves correctly for API >= 23 (checks, rationale, request via fragment); it is invoked from native Objective-C code (`NoodlePermissionGranter ... asking for permission %i`), so the gating condition is native. Raising targetSdk does not change this. | 4 | 2 | none | E | later |
| 11 | "Privacy Setting Changed" dialog | N (string/logic in game code). | 4 | 2 | none | E | later |
| 12 | Ambient / jetpack sounds continue in main menu | N (OpenAL source teardown on leaving a world). | 4 | 3 | none | E | later |
| 13 | Signs: lowercase, centring, padding/wrapping | N (text rendering / allowed glyph set; bundled `BlockheadsFont` assets might need the lowercase glyphs; resources partially). | 5 | 3 | none | E, maybe B/C for assets | later |
| 14 | Game crashes when the WebView crashes | J. No `onRenderProcessGone` handler exists in the 1.7.6 dex files (1.7.4/1.7.5 not yet re-checked), so a renderer crash kills the host process. Adding a handler to the web-view client classes (`BlockheadsWebViewClient`, `com.apportable.ui.WebView*`) is a small dex change. | 3 | 2 | none | D | next after the DEX layer exists |
| 15 | Welcome messages lose newlines / non-ASCII | N (and maybe J: text goes through the web-view bridge). | 4 | 3 | related to fix-welcome-popup-deadlock only by feature area | E (D if the Java bridge is guilty) | later |
| 16 | Main menu resets to latest world after suspend/resume | N / J (state restore in `onSaveInstanceState` / native resume). | 4 | 3 | none | D, E | later |

## targetSdk analysis (item 5)

Raising `targetSdkVersion` changes platform behaviour for the app. What we checked against the game:

* **28: cleartext HTTP is blocked by default.** The game talks to `http://` endpoints (portal, price server and
  `join.php` URLs are in the native binary). Mitigated with `usesCleartextTraffic="true"`. Raw native sockets are not
  affected by the policy.
* **28: Apache HTTP legacy removed from the boot classpath.** The game ships the library classes in its own dex files
  (about a thousand `org.apache.http` classes), so it does not depend on the platform copy.
* **29: scoped storage.** Mitigated with `requestLegacyExternalStorage="true"` (honoured for apps targeting 29, ignored
  for 30+, which is why we stop at 29).
* **30+: package visibility** (the game queries installed activities for mail/share via `PackageManager`; it would see
  nothing without `<queries>`), forced scoped storage, and from 31 mandatory `android:exported` on components with intent
  filters (`VerdeActivity` declares filters without it, so install would fail). Therefore the patch deliberately stops at **29**.
* Other changes at 28/29 (foreground services, background activity starts, camera/location) do not apply: the game has no
  foreground service, requests no location/camera permissions and starts nothing from the background.
* `sharedUserId` is still honoured at these levels.

Not verified on a physical device (none was available), hence **opt-in** (off by default, badge in the UI). A device
test of start-up, world loading, store screen, in-game browser/web pages and shared storage is required before making it
the default. The warning threshold of newer Android releases could not be confirmed from the documentation; if a release
requires a higher target the patch value is one constant (`TARGET_SDK`).

## Implemented in this iteration

`enable-audio-capture`, `keep-data-on-uninstall`, `disable-multi-window`, `raise-target-sdk` (all manifest-only, all three
versions, verified on the real 1.7.4/1.7.5/1.7.6 APKs: aapt2 parses the output, v1+v2 signatures verify).

## Proposed order for the rest

1. Manifest insertion capability (A) then item 7 (join links) -- smallest remaining step, high user value.
2. Resource table layer (B + C) then item 1 (adaptive icon).
3. DEX layer (D): first the lowest risk edits -- item 14 (WebView crash handler), item 9 (e-mail body), then items 4, 2, 6b/6c/6e, 16.
4. Per-version native patching (E): items 10, 11, 12, 15, 8, 13, 6a, with a hash-pinned patch table per version and the
   same safety checks as `makeNativeStubPatch` (library hash plus expected original bytes).
5. Device-dependent items (4, 6b, 6c) need real-device logs; schedule them with a test device or emulator running the game.

## Item 7 notes (`fix-join-links`)

* Java side (own analysis of the dex): `VerdeActivity` passes `Intent.getDataString()` unchanged to the native
  `nativeHandleUri(String)` on cold start (`onCreate` path) and from the `onNewIntent` path (launchMode `singleTask`). The
  OS therefore only has to route the link; the game receives the full URI string (`blockheads://...` or
  `http(s)://theblockheads.net/join.php?...`).
* The patch replaces all VIEW filters that carry `<data>` with: (1) scheme `blockheads`; (2) schemes `http`+`https`, hosts
  `theblockheads.net` + `blockheads.noodlecake.com` (the host the original third filter named), path `/join.php`; both with
  DEFAULT+BROWSABLE. `autoVerify` is unset (no Digital Asset Links file we control, so links show the chooser rather than
  opening the game silently). `android:exported="true"` is added to the activity.
* Needs a device test: the native binary only contains `http://theblockheads.net/join.php?...` and a `blockheads://`
  literal; we did not trace whether the native parser accepts `https` or a `blockheads://` URI exactly as delivered. If
  https is rejected, drop it from `joinLinkFilters()` (one line).
