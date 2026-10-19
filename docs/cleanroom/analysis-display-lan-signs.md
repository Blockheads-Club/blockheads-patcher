# Analysis: display and rotation (item 6), LAN (item 8), signs (item 13)

Scope: analysis only, no patch code. Sources: our own static analysis of the three user-owned APKs (1.7.4 / 1.7.5 /
1.7.6): `aapt2 dump`, `dexdump -d`, `llvm-objdump`, an ObjC metadata walker we wrote, strings, plus our own device log
`reverse-engineering/runlogs/logcat_phone3.txt` and `docs/client_re/patches_verified.md`. Nothing from the upstream
repository was read. All addresses are virtual addresses in `lib/armeabi-v7a/libApplication.so`; for this library
the executable PT_LOAD maps file offset == virtual address for the ranges below (1.7.4 differs only in the data
segment, which none of the patches touch). ARM mode (not Thumb) at every site listed.

Evidence tags: OBSERVED (device log), STATIC (read in code), INFERRED (reasoned, needs a device).

## 0. Shared facts

* `libApplication.so` statically contains Apportable's UIKit (UIDevice, UIScreen, UITextView, ...), the game and the
  mDNS-based NSNetService glue is in `libFoundation/libCFNetwork/libSystem`. Java glue is `com.apportable.*`.
* Binary identities (sha256 of the library inside the APK):
  1.7.4 `e40f53436fe3028aefaa678f2312aab9d2a9a024747aa797d6334494cf225861` (BuildId b76f2734...),
  1.7.5 `d09418e9c0865902054a71358dcff3264d47f7b24ede58667cb5ea0e6f269b96` (BuildId 876c54e1...),
  1.7.6 `733d821027d69de329d0ba171df2e6013d612edf5a4d327badd001acc30b94c7` (BuildId 81b7aa3e...).
* `classes.dex` is byte-identical in 1.7.4 and 1.7.5 (sha256 prefix e5ed1acecd724bbc); 1.7.6 differs (d8a2b3c0640e3ebd)
  only by renumbered ids, the relevant methods have the same bodies. Dex patches should be addressed by
  class/method signature plus an expected-instruction check, not by raw offsets (offsets given below only as a
  cross-check).
* Manifest: `VerdeActivity` has `screenOrientation=1` (portrait), `configChanges=0x40000fff` (mcc, mnc, locale, touchscreen,
  keyboard, keyboardHidden, navigation, orientation, screenLayout, uiMode, screenSize, smallestScreenSize, fontScale).
  NOT covered: density 0x1000, layoutDirection 0x2000, colorMode 0x4000. Application meta-data:
  `apportable.splash_screen_type=letterbox`, `apportable.orientation=portrait`.
* `assets/Info.plist` (read by `SplashScreen.show`): `UISupportedInterfaceOrientations` and the `~ipad` variant list all four
  orientations; the default is portrait. So the Java splash sensor listener is active (`orientations == 15`).
* The only `~ipad` assets in the APK are the four splash images `Default-Portrait~ipad.png`, `Default-Portrait@2x~ipad.png`,
  `Default-Landscape~ipad.png`, `Default-Landscape@2x~ipad.png`. There are no `~ipad` UI textures.

## 1. Item 6 - display

### 6a. Tablets should use the iPad layout; splash by device type, resolution, orientation

Root cause, what is known:

1. The device idiom is an environment variable. `-[UIDevice userInterfaceIdiom]` returns a cached value computed once
   (dispatch_once block) from `getenv("TABLET")`: any of `yes`, `true`, `1` (case-insensitive) means iPad, otherwise iPhone.
   STATIC. Addresses: 1.7.4 0x2673f4, 1.7.5 0x2671f4, 1.7.6 0x267174 (block body +0x7c, helper +0x7c..).
2. Nothing sets `TABLET`. `LibraryManager.initializeLibv()` (Java) exports a fixed set of variables (HOME, TMP, PACKAGE_NAME,
   LOCALE, TZ ...) and then copies **every application `<meta-data>` entry** into the environment with `LibraryLoader.setenv(key, value.toString())`
   (loop over `ApplicationInfo.metaData.keySet()`); then calls the native `LibraryLoader.init()`. So an app meta-data named
   `TABLET` with value `yes` would flip the idiom for every device. STATIC (that is also why `apportable.orientation` and
   friends exist as env names).
3. Consumers of the idiom in game code are few (STATIC xref): `-[UIImage initWithContentsOfFile:]` and
   `-[UINamedImage(Noodlecake) initWithFilePath:getBestImage:]` (`~ipad` file name suffix, only matters for the splash
   files), `-[GameView presentPickerUIWithSourceType:]`, `imagePicker:pickedImage:`, `imagePickerDidCancel:`,
   `presentShareUIForImage:`, `presentShareUIForURL:message:rectFromScreenCenter:`, `instructionsButtonTapped` and the GameKit crop
   views. The pad branches of the picker/share code use `UIPopoverController`, and Apportable's `UIPopoverController` only
   has three methods (`delegate`, `setDelegate:`, `contentViewController`); there is no `presentPopoverFromRect:...`. INFERRED
   risk: flipping the idiom on a tablet may crash or no-op when the user taps photo/share/instructions. This must be
   tested before shipping; it is the main risk of this item.
4. The rest of the "layout" is size driven, not idiom driven. `UIScreen preferredMode` asks `+[UIScreenMode emulatedMode:]` for mode 12, which is the
   *native* mode: `UINativeScreenMode` takes the real display pixels (`windowManager.defaultDisplay.realMetrics`) and a
   scale derived from `VerdePluginNativeDpiX/Y`, then `-[UIScreen(Apportable) setContentWidth:height:]` feeds the logical size
   to Java (`VerdeActivity.setContentSize`). We did not find an iPad branch keyed on idiom in the world/menu UI code, so
   "iPad layout" on Android most likely means (a) idiom = pad and (b) a logical size close to 1024x768 points. The mode-12 scale rule
   (dpi to scale) was not decoded; it is the place to look if the tablet UI is too small/large. INFERRED.
5. The splash is Java: `SplashScreen.getSplashScreen()` tries only `Default-568h@2x.png`, `Default-568h@2x~iphone.png`,
   `Default@2x.png`, `Default@2x~iphone.png`, `Default.png`, `Default~iphone.png`; the iPad splash files are never tried, and
   `SplashScreen.show` then letterboxes the portrait phone image, rotating it according to sensor/`apportable.orientation`.
   `VerdeActivity.getSplashScreenWidth/Height` return `Display.getWidth/getHeight` (deprecated, rotation dependent).

Patch plan (all versions; Java parts are shared 1.7.4/1.7.5, equivalent in 1.7.6):

| Part | Layer | Site | Change |
| --- | --- | --- | --- |
| Tablet idiom | DEX | `com.apportable.LibraryManager.initializeLibv()V`, the final `invoke-static {} LibraryLoader.init()V` at code unit 0x247 (file 0x47136 in 1.7.4/1.7.5, 0x43c9e in 1.7.6) | Redirect this one same-sized (3 unit) `invoke-static` to a new helper `Lcom/apportable/PatchHooks;.init(Lcom/apportable/LibraryManager;)V` (needs an added class and method id, or reuse the arg-less form and read `VerdeApplication.getApplication()`). Helper: if `getResources().getConfiguration().smallestScreenWidthDp >= 600` call `LibraryLoader.setenv("TABLET","yes")`, then call `LibraryLoader.init()`. Registers v0..v3 are free at that point; v10 is `this`. |
| Tablet splash | DEX | `SplashScreen.getSplashScreen()Ljava/io/InputStream;` (begins file 0x4c588 in 1.7.4/1.7.5, 0x49118 in 1.7.6) | Replace the body by a call to a helper that, on tablets (same predicate), opens `Default-Portrait@2x~ipad.png` when the display's long side is >= 1536 px, else `Default-Portrait~ipad.png`, and otherwise falls back to the original list. Always use the portrait pair: `show()` already rotates the image to the current orientation (it keys on `apportable.orientation=portrait`), the landscape pair is not needed. |
| Optional | none | meta-data `TABLET=yes` | Manifest-only variant, but it applies to phones as well. Not recommended. |
| Resources | none | | No arsc work needed for this item. |

Layers needed: DEX editing with the ability to add a class (+ method ids) or at least to retarget a call to an existing method. Manifest and
arsc layers are not needed. Native not needed.

Risk: medium-high (idiom pad paths in GameView, see above). The splash part is low risk.
Verify on device (tablet or Fold unfolded): game starts, main menu sizes sane, tap "photo", "share", "instructions";
splash is the iPad image and is not stretched in both rotations; confirm `getenv("TABLET")` via a log line from the helper.

### 6b. Native landscape launch / brief right-landscape rotation at start-up / tilt problems

Mechanisms found (STATIC):

* Launch is forced portrait by the manifest. During the game the orientation is changed at run time by Java
  `VerdeActivity._setRequestedOrientation(int)`: it maps the iOS-style value 1 -> SCREEN_ORIENTATION_PORTRAIT(1),
  2 -> REVERSE_PORTRAIT(9, API > 8), 3 -> LANDSCAPE(0), 4 -> REVERSE_LANDSCAPE(8, API > 8), anything else keeps the previous value.
  Native `-[UIDevice(Platform) _platform_setOrientation:]` calls `[VerdeActivity setRequestedOrientation:]`, then `UIApplication
  setStatusBarOrientation:` and `UIScreen _applyMode` (which re-publishes the logical content size).
* Two independent drivers call it. (1) While the splash is up, `SplashScreen$1` (an `ApportableOrientationEventListener`)
  maps the sensor angle (bands 315-45 portrait, 45-135 -> 4, 135-225 -> 2, 225-315 -> 3, debounce 400 ms) to
  `_setRequestedOrientation`, restricted by Info.plist (all four allowed), and uses `isLandscapeDevice` to shift the angle by 90.
  (2) After the game is up, `Device$1` (another sensor listener, enabled by native `_platform_beginOrientationMonitoring`)
  forwards the raw angle to native `Device.nativeOnOrientationChanged(obj, deg)`, which goes to `-[UIDevice _setOrientation:changed:]`
  -> `shouldAutorotateToInterfaceOrientation:` of the root controller. `-[EvolutionViewController
  shouldAutorotateToInterfaceOrientation:]` returns `[UIDevice isAutorotationOn] && allowsRotation`; `Device.isAutorotationOn()` reads
  `Settings.System.accelerometer_rotation`.
  Consequence: with system auto-rotate OFF the native side never rotates (stays in the launch orientation), while the Java
  sensor listeners still run.
* `isLandscapeDevice` is computed independently in three places (`SplashScreen.show` once, `Accelerometer.<init>` once,
  native `-[UIDevice(Apportable) isLandscapeDevice]`) from `Configuration.orientation` versus `Display.getOrientation()`.
  The two Java copies are one-time snapshots taken at construction.
* Tilt: `-[World acceleration:]` rotates the accelerometer vector using `[UIApplication statusBarOrientation]`; the Java `Accelerometer`
  swaps/negates axes with its cached `isLandscapeDevice`. So tilt is correct only if the cached flag and the status-bar orientation
  both agree with what the display is really doing.

Hypotheses for the three symptoms (INFERRED, all need logcat from a device):

1. *Brief right-landscape at start-up with auto-rotate on*: the splash sensor listener fires while the user holds the phone
   slightly rotated (or flat, angle jumps), and sets REVERSE_LANDSCAPE (iOS value 4) once, then the game (which starts from the
   portrait Info.plist default) rotates back. The 400 ms debounce lets exactly one event through.
2. *Tilt broken with auto-rotate off or flat at launch*: with auto-rotate off native never updates `statusBarOrientation` (see
   shouldAutorotate), and with the phone flat the sensor angle is -1 (ORIENTATION_UNKNOWN) so no listener ever fires; the cached
   `isLandscapeDevice` is then wrong or the status-bar orientation is stale.
3. *Native landscape launch*: with `screenOrientation=portrait` the window is created portrait and then rotated; on tablets and
   foldables the natural orientation is landscape, so portrait-forced start is a letterboxed sideways window.

Patch plan (design, choose after the device logs):

| Goal | Layer | Site | Change |
| --- | --- | --- | --- |
| Do not force portrait at launch | Manifest | `VerdeActivity` attribute `android:screenOrientation` (value 1) | Change to `fullUser` (13) or `user`(`2`), or `unspecified`(-1). Binary AXML attribute value only; the manifest layer must be able to rewrite an existing int attribute in place. Runtime `setRequestedOrientation` keeps working. |
| Kill the start-up wobble | DEX | `SplashScreen.show(FrameLayout)`: the construction of `SplashScreen$1` and `enable()` call (offset 0x124-0x12d in 1.7.6 code units); or `SplashScreen$1.onOrientationChangedWithCompatibilityAdjustments(I)V` | Skip enabling the listener (branch over the `new-instance`/`enable`), or ignore events until the first `Device` listener is enabled. Smallest edit: make the `if-eq` chain at 0x0112-0x0122 (the "single orientation" test) always taken, which skips creating the listener. |
| Tilt with auto-rotate off / flat | DEX | `Accelerometer.<init>` snapshot and the use in `onSensorChanged` (`iget-boolean isLandscapeDevice`, code unit 0x72) | Recompute `isLandscapeDevice` on every sensor event from `WindowManager.getDefaultDisplay().getRotation()` plus the natural orientation, instead of the constructor snapshot. Needs a helper method or inlined bytecode. |
| Native status-bar orientation at launch | Native (only if the DEX change is insufficient) | `-[UIApplication initializeOrientation]` (see objc listing) | Out of scope until logs prove it. |

Layers: manifest attribute edit (existing capability), DEX instruction-level edit. Risk: high (orientation state is global, interacts with
fold/resize). Verify: phone and tablet, auto-rotate on/off, flat on a table, held in landscape at launch; check the first frame is
the correct orientation, no flash, tilt (tilt-to-steer/placement) left/right in both landscape directions, and that rotating while
playing still works.

### 6c. Crashes on rotation on some devices

Strong evidence (OBSERVED): in `logcat_phone3.txt` the game's `ViewRootImpl` (`ViewRootImpl@...[blockheads]`) runs
`setView`, relayout and draw on thread 3969, not on the process main thread 3894. The activity window is therefore owned by
Apportable's own "MainThread". The existing note in `patches_verified.md` (P3) records a `CalledFromWrongThreadException` from
`ActivityConfigurationChangeItem -> ViewRootImpl.updateConfiguration` on the Android main thread on a Fold4.

Root cause (STATIC + OBSERVED, reasoned): whenever the platform dispatches a configuration change to the activity (because the
manifest declares it handled), `ActivityThread` calls `ViewRootImpl.updateConfiguration` on the real UI thread; if the cached
configuration differs it calls `requestLayout()`, which checks the thread and throws because the root view belongs to the Apportable thread. Which devices crash
depends on which configuration fields change (density, layout direction, colour mode and fold/size changes are NOT in
`configChanges`; orientation/screen size are) and the Android version.

Patch options:

1. Manifest (cheap, partial): add the missing `configChanges` bits (density, layoutDirection, colorMode), (`resizeableActivity=false` was tried and made it worse: letterboxed on a Fold4 cover screen, the game crashed at every start; reverted by `allow-resizing`). Reduces relaunch/size-compat triggers but does not remove the thread check for handled changes.
2. DEX (real fix, hard): create the activity window/root view on the UI thread, or intercept `onConfigurationChanged` earlier. The window is created from
   `VerdeActivity$1` (the `FrameLayout` handed to `SplashScreen.show`) and the later `setContentView`/`rootOfAllEvil` code under `MainThread`; a proper fix needs moving those
   `addView/setContentView` calls to the main looper. Needs device debugging; do not attempt blind.
3. Do not declare orientation as handled for the problem classes, so Android relaunches instead (the game would need to survive `onCreate` twice; not tested).

Implemented (option 4, DEX, recommended): `fix-config-change-crash` (`packages/core/src/patches/fix-config-change-crash.ts`).
It does not move the window; it keeps the Android main looper alive past exactly this exception:

* New class `com.blockheadsclub.patch.LoopGuard implements Runnable`, added to the dex that holds `VerdeActivity`
  (`classes.dex` in 1.7.4/1.7.5/1.7.6). `install()` (static; a static `installed` flag makes it once per process, so an
  activity re-creation does not nest a second guard; the body is inside a `Throwable` handler so it can never break
  `onCreate`) posts `new LoopGuard()` to `new Handler(Looper.getMainLooper())`. `run()` is
  `for (;;) { try { Looper.loop(); return; } catch (Throwable t) { if (t.getClass().getName().equals("android.view.ViewRootImpl$CalledFromWrongThreadException")) Log.w("BlockheadsPatcher", "ignored a configuration change on the wrong thread", t); else throw t; } }`.
  The hidden exception class is matched by name; any other exception (also a wrapper around this one) still crashes as before.
* Hook: `invoke-static {}, LoopGuard.install()V` prepended to `VerdeActivity.onCreate(Landroid/os/Bundle;)V` (before
  `super.onCreate`). Activity lifecycle callbacks always run on the Android UI thread, and `onCreate` is the first game code
  there (it also builds `rootOfAllEvil` and starts the library loader). The posted guard runs right after the launch message;
  from then on every main-thread message is dispatched from the nested `Looper.loop()`.
* Detect: `applied` when the class exists and `onCreate` calls it; `notApplied` when `VerdeActivity.onCreate(Bundle)` has
  code; `incompatible` otherwise. A partial state (class or hook missing) is completed.
* Known side effects (reasoned, not device-tested): the client transaction item that threw stops right after
  `ViewRootImpl.updateConfiguration` (`Activity.onConfigurationChanged` has already run), and later items of the same
  `ClientTransaction` are skipped (newer Android versions may batch several items). Recent Android versions log one `Looper`
  warning ("Loop again would have the queued messages be executed before this one completed") per (re-)entry.

Verify: get the exact exception from logcat on a crashing device first (stack must show `ViewRootImpl.checkThread` or another cause), then test rotation x
fold/unfold x split-screen x font/density change. Risk: high. Layers: manifest (option 1) and DEX (option 2).

### 6d. Dialog orientation (native dialogs)

Native dialogs are `com.apportable.ui.AlertView` (Android `AlertDialog`) and `Window$WindowDialog`; they follow the *activity's* requested orientation, which
is changed through `_setRequestedOrientation`. The game also has its own OpenGL `BlockAlertView`, which reads `-[UIApplication statusBarOrientation]` at creation
(`alertWithTitle:message:`, `usingInterfaceOrientation:` variant exists). The mismatch scenarios are therefore the same state problems as 6b (status-bar orientation stale vs. real display rotation, auto-rotate off, splash listener).
No separate patch site was identified; fix 6b first, then retest dialogs. Verify with each dialog type (alerts, text prompt, web dialog, photo picker) in both landscape directions with auto-rotate on and off.

### Already handled: multi-window

`android:resizeableActivity="false"` was implemented as `disable-multi-window` and reverted: on a Fold4 cover screen it letterboxed the game, hiding the status bar then changed the window and the configuration change crashed the game at every start (6c). `allow-resizing` writes `true` and repairs games patched with it.

## 2. Item 8 - LAN hosting / joining

What exists (STATIC): the UI and the netcode are complete and contain no Android gate that we could find.
`-[LoadWorldUI hostMultiButton:]` builds the "HOST LOCAL NETWORK..." button, `hostMultiLANButton:` the host dialog,
`-[JoinWorldUI advancedLocalNetworkButton:]` the "JOIN LOCAL WORLD" label, `finalJoinButton:` references `joinLanWorldButtonTapped`.
Hosting: `-[BHNetServerMatch startServer]` (1.7.4 0x69d048, 1.7.5 0x69ce38, 1.7.6 0x69cce0) creates an `NSNetService` with domain `local.`, type
`_blockheads_1_7._tcp.` (format `_%@._tcp.`), port from the ENet host, and `publish`es it on the run loop. Joining:
`-[BHNetClientMatch startSearchForServers]` -> `NSNetServiceBrowser searchForBrowsableDomains` -> `didFindDomain:` ->
`searchForServicesOfType:inDomain:` -> `didFindService:` -> `resolve` -> `netServiceDidResolveAddress:`.
The only Reachability use is `connected` (internet) in World/MainMenuUI/CloudInterface; none of it gates LAN.

Underneath (STATIC): `NSNetService`/`NSNetServiceBrowser` are fully implemented in `libFoundation.so` on top of `CFNetService` in
`libCFNetwork.so`, which calls `DNSServiceRegister/Browse/Resolve` in `libSystem.so`. `libSystem.so` embeds a POSIX mDNSResponder
(`mdns_posix_daemon_main`, `_CreateMDNSDaemonIfNeeded`, strings `/var/run/mDNSResponder.pid`, `/etc/mdnsd.conf`, user `nobody`).
So the stack is present but was evidently built for a desktop-style filesystem and the platform does not satisfy it. Candidate causes, in order of likelihood (INFERRED, none verified):

1. **No multicast on Wi-Fi.** The app never acquires a `WifiManager.MulticastLock` and lacks `CHANGE_WIFI_MULTICAST_STATE` (manifest permissions are only
   `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `INTERNET`, `WRITE_EXTERNAL_STORAGE`, `BILLING`). Most Android Wi-Fi drivers drop inbound multicast without the lock, so mDNS answers
   are never received: browsing finds nothing although publishing may "work".
2. **Daemon bring-up / IPC fails in the Android sandbox** (`/var/run`, `/etc/mdnsd.conf`, `nobody`, client-to-daemon channel). Then `publish` fails with
   `netService:didNotPublish:` (the game logs `netService:didNotPublish:%@`), which is a visible symptom in logcat.
3. Interface enumeration (getifaddrs/netlink) quirks; not an issue below targetSdk 30, which is one reason `raise-target-sdk` stays below 30 (it now uses 28, see its source).

Patch plan:

| Step | Layer | Site | Change |
| --- | --- | --- | --- |
| A | Manifest | `<uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE"/>` | Insert a new element (needs the manifest element-insertion capability); normal permission, no prompt. |
| B | DEX | `VerdeActivity.onCreate` / `onResume` / `onPause` (or `VerdeApplication.onCreate`) | Acquire a `WifiManager.createMulticastLock("blockheads")` (reference counted off) when the game runs and release when destroyed; add a helper class. Needs the `ACCESS_WIFI_STATE` permission that is already present plus A. |
| C | none yet | | If A+B do not make browse/publish work, capture logcat for `didNotPublish`/`didNotSearch` error codes (`NSNetServicesErrorCode`) before touching native. A native fix would be inside `libSystem.so` (daemon start) and is per-library work: not recommended without logs. |

Layers: manifest insertion, DEX with an added helper class. Native only as a last resort. Risk: low for A+B (additive). Verify: two devices on one Wi-Fi (or one device + our PC port / server), host "LOCAL NETWORK" on one, "JOIN LOCAL WORLD" on the other; check logcat for the mDNS daemon starting; test with a guest network that blocks multicast (expected fail).

## 3. Item 13 - signs

All three sub-items are in the sign text editor, a game-drawn alert (`BlockTextPromptAlertView`, title "SIGN TEXT", created by `-[UIManager displaySignUIForSign:]`), which hosts an Android `EditText` through Apportable's `UITextView`; the result is rendered by `-[Sign updateBitmapString]` (BitmapString, bitmap fonts `04b03black_16`/`04b03embossed_16`).

### 13a. No lowercase

Root cause (STATIC): `-[BlockTextPromptAlertView text]` (1.7.4 0x9e5670, 1.7.5 0x9e5298, 1.7.6 0x9e5140) first word-wraps with `BitmapFont embossedFont`
`wrappedString:constrainedToWidth:120` (cuts to at most four lines), and then sends `uppercaseString`. `textViewDidChange:` writes `[self text]` back into the text view
(so the field shows the converted text live). The Sign then stores that string. The server stores sign text verbatim (no case folding in our server). All five bitmap fonts include 26 lowercase glyphs (`char id` 97..122) so
the renderer has the glyphs.

Native patch (hash pinned): replace the `blx r3` that performs the `uppercaseString` send, which is always the sequence `mov r1,r12 ; blx r3 ; str r0,[r11,#-0x3c]`,
with a NOP, so `r0` keeps the already-computed wrapped string (`mov r0,lr` right before loads it).

| Version | File offset == vaddr of the `blx r3` | Original word | New word |
| --- | --- | --- | --- |
| 1.7.4 | 0x9e58b8 | 0xE12FFF33 | 0xE1A00000 (mov r0,r0) |
| 1.7.5 | 0x9e54e0 | 0xE12FFF33 | 0xE1A00000 |
| 1.7.6 | 0x9e5388 | 0xE12FFF33 | 0xE1A00000 |

Preconditions to check before writing: library sha256 above, plus the 5 words at site-12..site+4 equal
`E1A0000E E58D100C E1A0100C E12FFF33 E50B003C` (verified identical in the three versions; the pattern is unique inside the function).
Layer: native fixed-word patch (the same framework as the former `fix-iap-store-font-crash`, `makeNativeStubPatch`). Risk: low-medium: the string passed on is an autoreleased
`NSString` just like the `uppercaseString` result; the subsequent code only retains/releases through messaging. Also check: the keyboard type set
for the editor is 1 (ASCII capable), no automatic capital forcing was found in Java (`TextView$EditText` has no `AllCaps`), and `textView:shouldChangeTextInRange:` accepts everything.
Verify on device: type `Hello`, see it live in the field and on the placed sign (client + a second client), reload the world, and check that
the 04b03 font renders distinguishable lowercase (it is a small-caps style pixel font; if lowercase looks identical to uppercase the fix is still correct).

### 13b. Sign editor text not centred

Root cause (STATIC): the game calls `setTextAlignment:` (value 1 = centre) on the text view, but Apportable's `-[UITextView setTextAlignment:]`
(1.7.4 0x2a48b4, 1.7.5 0x2a46b4, 1.7.6 0x2a4634) is a plain ivar store with no platform forward, and the Java `com.apportable.ui.TextView` has no
alignment/gravity API. The `EditText` is created in `TextView.init()` with a fixed gravity of `0x33` (TOP | LEFT).

DEX patch: in `com.apportable.ui.TextView.init()V`, the instruction `const/16 v1, #0x33` (code unit 0x000d, followed by `EditText.setGravity`) becomes
`const/16 v1, #0x31` (TOP | CENTER_HORIZONTAL). One literal halfword: file offset 0x6eddc (value at 0x6edda+2) in the 1.7.4/1.7.5 `classes.dex`, 0x6aec0 (0x6aebe+2) in 1.7.6; value
0x0033 -> 0x0031; dex checksum and SHA-1 header fields must be recomputed. Other `const/16 ... 51` occurrences in the file are unrelated methods, so the patch must be addressed by
method + expected literal, not by search.
Scope: this changes every `UITextView` on Android; the sign editor is the only user we identified, but check the other UITextView users (welcome message editor) in testing.
Layer: DEX (smallest possible edit; no instruction shifting). Risk: low.

### 13c. Padding and line wrapping differ from iOS

Causes (STATIC + INFERRED):

* Wrapping is done twice with different metrics: the editor wraps by Android's `EditText` (Blockheads font fallback, platform padding/background), the stored text is re-wrapped by
  `text` to 120 px with the 16 px bitmap font and then four lines max; the sign is drawn in a 130x48 box (dimensions constants 130.0 and 48.0 in `updateBitmapString`). iOS' `UITextView` has fixed 8 pt insets and renders the *same* font the game uses; the `EditText` uses the
  default Android typeface (Apportable cannot load `BlockheadsFont-Regular` by name, see P2 notes) and Android theme padding.
* Since `textViewDidChange:` replaces the field text with the wrapped string, a mismatch between the editor's own soft wrapping and the 120 px rule makes the text jump.

Patch options (need device tuning, so mark as follow-up after 13a/13b):

1. DEX in `TextView.init()`: after the gravity call add `setPadding(0,0,0,0)`/transparent background for the `EditText` and `setIncludeFontPadding(false)`; needs inserting instructions (instruction-shifting editor) or moving them into a small helper called instead of `setGravity`.
2. Match the editor's width to 120 px of logical width so soft-wrap and the `text` wrapper agree: native, `0x78` constant in `-[BlockTextPromptAlertView text]` and the 130 px sign box; only worth changing if device tests show the mismatch is width, not font metrics.
3. Typeface: have `TextView.setFont` load `assets/GameResources/Fonts/BlockheadsFont-Regular.otf` through `Typeface.createFromAsset` when the requested name is `BlockheadsFont-Regular` (DEX, helper class). This is the most faithful fix for the line-break differences.

Layers: DEX with added helper. Risk: medium. Verify: type a long phrase and compare wrapping with an iOS reference screenshot (we have no iOS device; compare against the PC port renderer) and with how the placed sign draws.

## 4. Layer requirements summary

| Layer | Needed for |
| --- | --- |
| Manifest attribute edit | 6b launch orientation, 6c optional `configChanges` |
| Manifest element insertion | 8 (`CHANGE_WIFI_MULTICAST_STATE`) |
| resources.arsc | none for these items |
| DEX: literal / call retarget | 13b (literal), 6a (retarget one call + body replacement), 6b |
| DEX: add class/method | 6a (TABLET helper, splash helper), 8 (multicast lock), 13c |
| Native fixed-word (hash pinned) | 13a (one word per version) |
| Native beyond that | not needed in this batch |

## 5. Open points that need a device (nothing here is verified yet)

1. Whether `TABLET=yes` is enough to get a usable tablet UI and whether photo/share/instructions survive the pad idiom (6a).
2. Logcat of the start-up wobble and of a rotation crash (6b, 6c); the ViewRootImpl thread ownership explanation fits our Fold4 log but the exact exception on other devices is unknown.
3. mDNS: whether `didNotPublish` or silence; and whether a MulticastLock is enough (8).
4. Lowercase glyph shape and sign wrapping against iOS (13).
