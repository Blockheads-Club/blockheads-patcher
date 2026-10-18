# Analysis: audio lifecycle, suspend/resume freezes, main-menu reset (items 2, 4, 16)

Status: analysis only, no patch code. Static analysis of the user-owned 1.7.4 / 1.7.5 / 1.7.6 APKs. No device was
available; every statement is labelled **VERIFIED** (read directly from the binaries) or **HYPOTHESIS** (consistent with
the evidence, needs a device or log to confirm). Clean-room: only the public item descriptions from the triage were used;
all findings come from our own disassembly (`llvm-objdump`, a small ObjC-metadata reader, baksmali from the Android SDK,
`aapt2`) and Android platform documentation. Names, addresses and short instruction descriptions are references to our own
findings, not copied code.

## 0. Summary

| Item | Root cause (short) | Layer | Patches |
| --- | --- | --- | --- |
| 2a music never starts while another app plays | native gate `otherAudioWasPaying` (set from Java `isMusicActive()`) permanently disables the music player for the session | DEX (preferred) or native | J-A1 or N-A1 |
| 2b music does not resume after backgrounding | `-[MJSoundManager restartMusicAfterActiveEvent:]` is an empty method; `stopMusicForDeactivateEvent` destroys the player | native | N-B1 |
| 2c main-menu music does not loop | loop flag is stored but never applied to the player created afterwards; and the value used (999) is not understood by the Java player (only -1 loops) | native (+ optional DEX) | N-C1 (J-C2 optional) |
| 2d audio-focus start-up stall (extra) | first focus request runs on the UI thread and blocks 2 s waiting for a service connection that only the blocked UI thread could deliver | DEX | J-A2 |
| 4 freezes on suspend/resume, other activities | UI thread blocks forever in `GLSurfaceView.surfaceDestroyed()` waiting for the game thread, which may itself be waiting for the UI thread (or idle) | DEX (+ small manifest) | J-D1, M-1, optional J-D2 |
| 16 menu resets to latest world | `-[GameView didBecomeActive]` unconditionally calls `-[MainMenuUI selectMostRecentlyPlayedWorld]` on every resume | native | N-D1 |

Key enabling fact (**VERIFIED**): the native audio and lifecycle code is instruction-for-instruction identical in all three
versions (function bodies compared after normalising addresses: equal hashes for every function used here). Only addresses
move. The expected-original bytes of every patched region are therefore the same in all three versions (hashes in section 6).
Likewise `classes.dex` of 1.7.4 and 1.7.5 are byte-identical, and 1.7.6 differs only in `VerdeActivity` (permission and
licence code, not touched here); all classes patched below are identical in all three.

No patch below needs a code cave. All native patches are in-place word replacements inside functions that have enough
dead space (details in section 6). One optional variant of N-D1 would need a writable data byte (see 4.3).

## 1. Background that all three items share

### 1.1 Binary conventions (VERIFIED)
* `lib/armeabi-v7a/libApplication.so`: ARM (not Thumb) code, compiled without optimisation, so the code is long and
  regular. Every ObjC method IMP is word aligned ARM code.
* Executable `LOAD` segment (R E, offset 0) maps virtual address == file offset (checked for `.text` in all three libraries).
  All addresses below are virtual addresses and are file offsets.
* Method addresses were obtained from the ObjC class/category metadata (`__objc_classlist` / `__objc_catlist`).
* 1.7.4 has no `interruptionBegan` / `interuptionEnded` in `MJSoundManager` (1.7.5 and 1.7.6 do); nothing patched here depends on them.

### 1.2 Threads and lifecycle path (VERIFIED unless noted)
* Java `MainThread` ("MainThread", big stack) runs the native app (`UIApplicationMain`); its run loop is unified with an
  Android `Looper` (`RunLoop.nativeNext`). `MainThread.tick()` runs registered tick actions, then drains the Looper.
* The UI thread (Android main thread) owns the activity and the `GLSurfaceView`. The game thread is the "render thread".
* Activity callbacks (`VerdeActivity.onPause/onResume/onStart/onStop`) run `nativeOn*` and `Lifecycle.onActivity*`. `Lifecycle`
  keeps a flag state machine and, when the combination of flags changes, calls the JNI methods
  `applicationWillResignActive` + `applicationDidEnterBackground` or `applicationWillEnterForeground` + `applicationDidBecomeActive`.
  Each JNI entry only posts a block to the main CoreFoundation run loop (`CFRunLoopPerformBlock`) and returns. The block
  ends in `-[GameView willResignActive]`, `didEnterBackground`, `willEnterForeground`, `didBecomeActive`.
* `VerdeActivity.onPause` also interrupts the MainThread Java thread (API >= 19) and exits the process if the splash screen is still shown.
  `onStop` removes the game `GLSurfaceView` from the view tree, `onStart` adds it back.

### 1.3 Audio stack (VERIFIED)
* Game code: `MJSoundManager` (sound effects through OpenAL; music through an `AVAudioPlayer` kept in the ivar `mp3Player`).
* `AVAudioPlayer` and `AVAudioSession` are Apportable shim classes inside `libApplication.so`. `AVAudioPlayer play/pause/stop/setNumberOfLoops:`
  forward to `AndroidAudioPlayer` -> Java `com.apportable.media.AudioPlayer` (one `android.media.MediaPlayer` per source).
  `AVAudioSession` forwards to `AndroidAudioManager` (Java) which binds `AudioManagerService` (a bound `Service` that holds the `AudioManager`).
* Music files are `.mp4` tracks under `GameResources/`: `mountainKingLoop.mp4` is the main-menu track, `largo.mp4` is the first
  in-world track; later in-world tracks are started by `-[World preRenderUpdate:...]` whenever `isPlayingMP3` is false and a timer (`lastMusicPlayTime`) allows it.

## 2. Item 2 - music

### 2.1 Music never starts if another app is already playing  (cause VERIFIED)

Chain:
1. `-[MJSoundManager reinitialize]` (runs at start-up) asks `[AVAudioSession sharedInstance] isOtherAudioPlaying` and stores the
   result in the ivar `otherAudioWasPaying` (offset 0x18).
2. The shim implements that call with Java `AndroidAudioManager.isMusicActive()`, which only returns a boolean cached in
   `mIsOtherMusicActive`; it is refreshed from `AudioManager.isMusicActive()` in `onCreate()` and `onResume()`.
3. `-[MJSoundManager safeToPlayMP3s]` returns `!otherAudioWasPaying`, and `playMP3IfSafe:withTimeOffset:` first asks it.
   `reinitialize` is only run again after an audio interruption ends, so one "yes" at launch disables all music for the whole session.
4. The game keeps the audio session in category `AVAudioSessionCategoryAmbient` (mix with others). `AndroidAudioManager.setCategory`
   maps Ambient to *abandon audio focus*, so the game never asks the other app to stop either. The iOS convention ("do not play
   our music over the user's music") was ported literally.
5. Nothing else reads `otherAudioWasPaying` (checked across the whole library, all versions).

Patch options (pick one; they are equivalent for behaviour):
* **J-A1 (preferred, DEX).** `com.apportable.media.AndroidAudioManager.isMusicActive()Z`: make it return false (replace the field read by constant 0). Same method in all three `classes.dex`.
* **N-A1 (native).** `-[MJSoundManager safeToPlayMP3s]`: replace the first two words by `mov r0,#1` / `bx lr` (addresses in section 6).

Result: the game's music plays together with the other app's audio (mix). That is what the Ambient category intends. A variant that
makes the game take audio focus (other app pauses) is possible by making `AndroidAudioManager.setCategory` request instead of
abandon focus for Ambient, but it activates the native focus-change machinery (`_platform_focus_changed:` ->
begin/end interruption -> `audioPlayerBeginInterruption:` stops the music, OpenAL context suspend) which is dormant today.
Not recommended without a device; mention to the user as a future option.

Risk: low. Verify on device: start Spotify/YouTube Music, launch the game from a cold start, music starts; stop the other app, nothing breaks; sound effects unchanged.

### 2.2 Audio-focus start-up stall (extra finding, relevant to 2 and 4)  (mechanism VERIFIED, effect HYPOTHESIS)
`AndroidAudioManager` binds `AudioManagerService` in its constructor (called from `VerdeActivity.onCreate`). The `ServiceConnection`
callback is delivered on the UI thread. `requestAudioFocusPermanent()` / `abandonAudioFocus()` first call the private
`waitOnConnection()`, which sleeps up to 400 x 5 ms (2 s) waiting for the service. `AndroidAudioManager.onResume()` (UI thread) calls
`requestAudioFocusPermanent()` when the default category (SoloAmbient) is still set, i.e. on the first resume after process start, before the native code has switched to Ambient.
On Android 9+ (activity create/start/resume executed in one transaction) the connection callback cannot run in between, so the UI
thread sleeps the full 2 s, then marks the service as failed; the first focus request is lost. On older releases it depends on message order.

* **J-A2 (DEX).** `AndroidAudioManager.waitOnConnection()V`: at entry, if `Looper.myLooper() == Looper.getMainLooper()` return immediately (do not set the failed flag). Uses only SDK classes; the method has 5 registers and two scratch registers are free at entry.
Risk: very low (the call it skips never succeeded anyway). Verify: cold start no longer has a 2 s UI stall (`adb logcat` shows no "Failed waiting for AudioManagerService!"; check with `Choreographer` skipped-frame lines).

### 2.3 Music does not resume after backgrounding  (VERIFIED)
* Going to the background: `-[GameView willResignActive]` ends by calling `-[MJSoundManager stopMusicForDeactivateEvent]`, which calls
  `stopMP3Playback` (saves the time, clears delegate, stops, releases and nils `mp3Player`, and nils `lastPlayedMP3Path`) and clears `currentlyActive`.
* Coming back: `-[GameView didBecomeActive]` calls `-[MJSoundManager restartMusicAfterActiveEvent:]`. That method is an empty stub in all three versions (it stores its argument and returns). Nothing restarts the menu track. In a world, the scheduler in `World preRenderUpdate` eventually starts another track, so the symptom there is a long silence.
* (`willResignActive` returns early without stopping music while a movie, ad, welcome message, purchase or text-entry hack is on screen - those paths never paused the music and are unaffected.)

**N-B1 (native, in place).** Pause instead of destroy, and resume only what was playing:
* `stopMusicForDeactivateEvent`: read `mp3Player` (offset 0x6c); if non-nil read the player's `_playing` byte (offset 0x2c), store it into the old `currentlyActive` byte (offset 0x72); if it was playing, tail-call `-[AVAudioPlayer pause]`'s IMP with `r0 = mp3Player`; otherwise return. 9 words (36 of the 108 available bytes).
* `restartMusicAfterActiveEvent:`: if `currentlyActive` is set and `mp3Player` is non-nil, tail-call `-[AVAudioPlayer play]`'s IMP; else return. 6 words, exactly the 24 bytes of the stub (conditional execution is used so no extra instruction is needed).
* `currentlyActive` is otherwise only written at initialisation, so reusing it as "paused by us" is safe; it is deliberately not cleared on restart (replaying an already playing player is harmless).
* The AVAudioPlayer IMPs are called directly (they ignore `_cmd`); both are normal ObjC methods in the same segment, so a PC-relative `b` reaches them.

Behaviour change to be aware of: the player object now survives backgrounding (previously destroyed). `lastPlayedMP3Path` is preserved, which the in-world scheduler reads.

Risks: medium-low. (i) If Android invalidates the `MediaPlayer` while the app is backgrounded for a long time, `play` is a no-op and the music stays silent until the next track (in a world) - no crash expected. (ii) A fade in progress when backgrounded is simply paused and continues. (iii) Interaction with `World preRenderUpdate`: while paused `isPlayingMP3` is false; the scheduler may start a new track right after resume and `loadMP3IfSafe` stops the old player first, so the worst case is a track change, not two tracks.
Verify on device: menu music -> home -> return (continues from the same position, no restart); in a world -> home -> return; lock screen and unlock; share-sheet round trip; phone call (focus is not held in Ambient, so only the lifecycle path matters); long background (several minutes) then return.

Fallback if pausing misbehaves on some device: keep stop semantics and replay via `playMP3IfSafe:withTimeOffset:` using the retained `playingURL` ivar (offset 0x30) and `stopMP3time` (offset 0x28); that needs a code cave (path string and a double on the stack) and was not chosen because it is larger and riskier.

### 2.4 Main-menu music does not loop  (VERIFIED, two independent causes)
1. **Flag is never applied.** `-[MJSoundManager setLoopMP3s:]` stores the flag in `loopMP3s` (offset 0x59) and applies it *only to the existing* `mp3Player` (numberOfLoops = 999 for YES, 0 for NO). The three places that start the menu track call `setLoopMP3s:YES` *before* `playMP3IfSafe:` with the menu path: `-[GameView initOpenGL]` (cold start), `-[GameView gameSoundFinshedFadingOut]` (return to menu after a world fade-out), `-[GameView actuallyDoExitWorldRightNowReallyNow]` (return to menu when nothing was playing). At that moment the old player is nil or about to be replaced, so the new player is created with the default (no loop). `loadMP3IfSafe:withTimeOffset:` never reads `loopMP3s`.
2. **Value not understood by the Java player.** `AudioPlayer.setNumberOfLoops(int loops, int audioId)` calls `MediaPlayer.setLooping(true)` only when `loops == -1`; 999 results in `setLooping(false)`. (iOS semantics: any negative value = loop forever.)

Do not simply apply the flag inside `loadMP3IfSafe`/`playMP3IfSafe:`: `-[GameView mainMenuSoundFinshedFadingOut]` starts the first in-world track (`largo.mp4`) while the flag can still be YES; applying the flag generically would make that track loop forever and starve the world's music scheduler.

**N-C1 (native, three parts, all in place):**
* **N-C1a**: in `setLoopMP3s:` change the instruction that loads 999 (`movw r2,#0x3e7`, word `e30023e7`, at function + 0x58) to `mvn r2,#0` (`e3e02000`). `numberOfLoops` becomes -1.
* **N-C1b**: rewrite the 88-byte wrapper `-[MJSoundManager playMP3IfSafe:]` as two entry points in its own space (60 bytes): entry A = unchanged behaviour (call `playMP3IfSafe:withTimeOffset:` with offset 0.0 passed on the stack); entry B at wrapper+0x20 = "play menu music": call entry A, then call the IMP of `setLoopMP3s:` with `loopMP3s` as argument. Both are plain C-style subroutines, no ObjC metadata change.
* **N-C1c**: at the three menu-start call sites replace the `blx r3` (word `e12fff33`, the `objc_msgSend` call) that follows the `playMP3IfSafe:` selector load with `bl <entry B>`. At those sites r0/r1/r2 already hold receiver, selector and path, the return value is unused, and the enclosing functions saved `lr`.

Alternative for N-C1a only: **J-C2 (DEX)** `AudioPlayer.setNumberOfLoops(II)V`: change the `loops == -1` comparison into `loops != 0` (same instruction size). Native is preferred because it keeps the ObjC property at its documented infinite-loop value; the DEX route also benefits any other caller.

Risks: low-medium. (i) The three call sites and the wrapper are the only users; `mainMenuSoundFinshedFadingOut` and the world scheduler still use entry A. (ii) `render:` already calls `setLoopMP3s:NO` when a world is joined; with a really looping player this now actually stops the loop (intended). (iii) A looping `MediaPlayer` and the cross-fade code (`runFade`) are independent. Verify: cold start with at least one prior play session (the menu track is skipped when total play time < 1 s, so use a profile with history) - the track restarts seamlessly after it ends; start a world, the in-world track must not loop and the next track must still come; leave the world, menu track loops again; background/resume (with N-B1) keeps looping.

## 3. Item 4 - freezes on suspend/resume, web pages, photo picker

### 3.1 What the existing fix tells us
`fix-welcome-popup-deadlock` gives `BlockheadsWebView` (the welcome-message viewer/editor activity, started by `NoodleWebView.showBlockheadsWebView`) a translucent theme. A translucent activity on top only *pauses* the game activity; with an opaque one Android *stops* it, the surface is destroyed, and the game freezes. That is the behaviour predicted by the mechanism below, which makes it the best current explanation for the rest of item 4 as well. **The welcome popup is a special case of "game activity gets stopped"**; the remaining reports are the same event reached by other routes.

### 3.2 Mechanism (code VERIFIED, deadlock itself HYPOTHESIS until a device trace)
* When the activity is stopped, `VerdeActivity$10` removes the game `GLSurfaceView`; the platform then calls `com.apportable.gl.GLSurfaceView.surfaceDestroyed(SurfaceHolder)` **on the UI thread**. The no-argument `surfaceDestroyed()` sets `mHasSurface=false`, notifies, and then `wait()`s on `mLock` **with no timeout** until `mWaitingForSurface` becomes true; `mExited` is never set anywhere.
* `mWaitingForSurface` is set only by `readySurface()`, which runs on the game thread as a `MainThread` tick action. So the UI thread resumes only when the game thread gets back to a tick.
* Several things can keep the game thread from ticking: (a) it is blocked in `ThreadUtils.runOnThread(Runnable, wait=true, ...)`, which posts to the UI thread and waits on the activity monitor - the UI thread can never run it (classic deadlock; the wait variant is public and native code reaches Java UI classes through the bridge); (b) it is idle inside the unified run loop because the render timer was stopped by `didEnterBackground`; the only wake-up the code has is `Thread.interrupt()` in `onPause` (whose effect on the native wait is unknown), and the lifecycle JNI entries post their blocks with `CFRunLoopPerformBlock` but never call a wake-up function (**VERIFIED** by disassembly of `Java_com_apportable_Lifecycle_*`); (c) a long native operation.
* While the UI thread is stuck there, `onStop`'s queued work, the result of `startActivity`, ANR timers and everything else UI-related stall, so the user sees a frozen game or an ANR dialog.

### 3.3 Triggers (all end in "game activity stopped")
Home / recents / lock screen; the share chooser (`SocialShareManager.sendShare`, `startActivityForResult`); the in-game photo picker (`UIImagePickerController.viewDidAppear` starts an `ACTION_PICK` on `content://media/internal/images/media` through `AndroidActivity startActivity:forResult:`; result comes back through `VerdeActivity.onActivityResult` -> `nativeOnActivityResult`); opening a URL in the browser (`VerdePluginOpenURL`); `BlockheadsWebView`; `TextViewHaxActivity` (see below); ad activities; Google sign-in. Web views that live inside the game window (`com.apportable.ui.WebView`, `MoreGamesFragment`) do not stop the activity and are not part of this problem.

`com.apportable.ui.TextViewHaxActivity` is an activity with **no theme attribute** in the manifest (opaque). It is started by `TextView$EditText` as a keyboard workaround and itself shows a small web page ("Attempting to get keyboard working...", `file:///android_asset/GameResources/instructions/`). This is probably the "WebView page" freeze that remains after the welcome-popup fix.

### 3.4 Patch plan
* **M-1 (manifest, trivial).** Give `com.apportable.ui.TextViewHaxActivity` the same translucent theme the existing patch uses (`@android:style/Theme.Translucent.NoTitleBar.Fullscreen`, 0x01030011) - same code path as `fix-welcome-popup-deadlock`, new activity name. Verify the page still looks right (it is full-screen content in its own layout). Risk low.
* **J-D1 (DEX, main fix).** `com.apportable.gl.GLSurfaceView.surfaceDestroyed()V` (public, 3 registers; identical in all three versions): replace the body with: (1) `Handler h = MainThread.getHandler(); if (h != null) h.sendEmptyMessage(0)` - an empty message wakes the game thread's Looper without needing a helper class, so it reaches its next tick and `readySurface()`; (2) take `mLock`, set `mHasSurface=false`, `notifyAll()`; (3) wait in a loop with `mLock.wait(remaining)` until `mWaitingForSurface || mExited` **or a deadline of about 250 ms** (use `SystemClock.uptimeMillis()`); (4) on `InterruptedException` re-assert the interrupt flag and leave the loop (the current code re-interrupts and spins). The method needs more registers; author it as smali text (symbolic `p0`) or remap parameter registers when raising the register count.
  Rationale: the framework's contract is that the surface may not be used after `surfaceDestroyed` returns; the game thread discovers this on its next `readySurface()` and already handles a missing surface by tearing down EGL and waiting. A bounded wait turns an unbounded freeze into at worst a short stall; with the wake-up the common case does not time out at all. Risk: low-medium (EGL surface may be destroyed a few ms after the window surface is released; `swap()` already reports failure by returning false).
* **J-A2** (section 2.2) removes a separate 2 s UI stall on cold start.
* **J-D2 (DEX, optional hardening, HYPOTHESIS).** In `com.apportable.Lifecycle.testInBackground()V`, after each pair of native lifecycle notifications, post `MainThread.getHandler().sendEmptyMessage(0)` (null-checked). Purpose: make sure the main CF run loop executes the posted blocks promptly even when the game thread is idle (the "game does not wake up after returning until you touch the screen" variant). Add only if device tests show that symptom.
* **Do not change** `onPause`'s `MainThread.interrupt()` without evidence; it looks like a (crude) wake-up that other code may depend on.
* The existing theme patch stays; J-D1 makes it redundant but harmless.

### 3.5 Per version
Java only; `GLSurfaceView`, `Lifecycle`, `ThreadUtils`, `MainThread`, `AndroidAudioManager` are identical in 1.7.4, 1.7.5, 1.7.6. Nothing native. The manifest entry exists in all three.

### 3.6 Verify on device (needs logcat and, for confirmation of the hypothesis, `adb shell kill -3` / `jstack`-style traces before patching)
Reproduce on an unpatched build first: home button during menu and during gameplay; share sheet; photo picker; TextViewHax path (enable a keyboard-less condition or a hardware setup where the hack triggers); take a thread dump when frozen (expected: UI thread in `GLSurfaceView.surfaceDestroyed` -> `Object.wait`, `MainThread` in `ThreadUtils.runOnThread`/`Object.wait` or idle in `RunLoop.nativeNext`). After patching: the same actions, 30 repetitions, plus rapid home/return, rotation lock on/off, split-screen (if not disabled), phone call, and low-memory return (activity recreated: expect a cold restart, which is existing behaviour).

## 4. Item 16 - main menu resets to the most recently played world

### 4.1 Cause (VERIFIED)
`-[GameView didBecomeActive]` (runs at launch and after every return from the background) refreshes the save list and then, when `mainMenuUI` exists, calls in this order: `populateGameSaves`, `-[MainMenuUI gameSavesChanged]`, `-[MainMenuUI selectMostRecentlyPlayedWorld]`. The last call is unconditional; it is the **only** caller of that method in all three versions. The method sets the selection fields to "most recent world / first menu page" (`currentWorldIndex`, `currentMainMenuSelection`, `scrollTargetIndex`, scroll position, drops the preview texture), discarding whatever the player had selected.
(An unrelated process kill by Android recreates the whole game, which legitimately starts at the most recent world; that cannot be fixed because the game saves no menu state in `onSaveInstanceState`.)

### 4.2 Patch N-D1 (native, in place, 9 words)
Keep the call only for the first activation after launch, using an existing flag: `GameView.hasRenderedFrameSinceActivate` (BOOL at offset 0x16a). `didBecomeActive` sets it to NO (after the call site) and `render:` sets it to YES; so at the call site it is "a frame was rendered during the previous active period", false only at the very first activation.
Replacement for the nine-word window that loads the receiver and selector and performs the call: load `self` from its stack slot, load `mainMenuUI` with a constant-offset load (offset 0x14, same in all versions), load the flag byte, `cmp #0`, load the selector and `objc_msgSend` exactly as before, but make the final call conditional on "equal" (`blxeq`). Words in section 6. The window has identical original content in all three versions.

### 4.3 Alternatives and risks
* **Unconditional skip**: replace the `blx r3` at the call site with `nop`. Simplest; the only risk is the very first launch (selection defaults come from `MainMenuUI` initialisation, probably equal to what the method sets, but not proven).
* **Exact one-shot flag**: needs one writable zero byte (e.g. a byte appended to the RW segment's `.bss`/padding) plus a small cave; only worth it if a device shows that `render:` can run before the first `didBecomeActive` (then N-D1 behaves like the unconditional skip at cold start).
* After a resume, `gameSavesChanged` still runs; if the save list shrank while backgrounded (world deleted by a server/cloud sync) the old `currentWorldIndex` could point past the end - check that `gameSavesChanged`/the renderer clamp it (device test: delete worlds via another route, resume).
Risk: low-medium. Verify: select the 3rd world, scroll, home, return - same selection and scroll; cold start - most recent world selected (as before); leave a world to the menu (uses another path, unchanged); play a world, home/return in-game (unchanged); first install without worlds.

## 5. Interactions and order
* N-B1 and N-C1 both touch `MJSoundManager` music but different functions; N-C1b changes the bytes of `playMP3IfSafe:` only. N-A1/J-A1 are alternatives; do not apply both unless desired (harmless).
* N-D1 is independent.
* J-D1 + J-A2 + M-1 are independent of the native patches; apply J-D1 first when testing item 4 because it can mask the audio focus stall symptoms.
* Suggested patch ids: `fix-music-other-audio` (J-A1), `fix-audio-focus-stall` (J-A2), `fix-music-resume` (N-B1), `fix-menu-music-loop` (N-C1), `fix-surface-destroy-freeze` (J-D1 + M-1, J-D2 optional), `fix-menu-reset-on-resume` (N-D1).

## 6. Per-version native patch tables
`LOAD` rule: file offset == virtual address for all addresses below. Library SHA-256 (pin): 1.7.4
`e40f53436fe3028aefaa678f2312aab9d2a9a024747aa797d6334494cf225861`, 1.7.5 `d09418e9c0865902054a71358dcff3264d47f7b24ede58667cb5ea0e6f269b96`,
1.7.6 `733d821027d69de329d0ba171df2e6013d612edf5a4d327badd001acc30b94c7`. "Orig SHA" = first 12 hex of SHA-256 of the original bytes of the replaced range (equal in all versions).

| Patch / site | 1.7.4 | 1.7.5 | 1.7.6 | Len | Orig SHA |
| --- | --- | --- | --- | --- | --- |
| N-A1 `safeToPlayMP3s` (first 2 words) | 0xb8c7e8 | 0xb8c410 | 0xb8c2b8 | 8 | cfa7aff34614 |
| N-B1 `stopMusicForDeactivateEvent` | 0xb8b698 | 0xb8b2c0 | 0xb8b168 | 36 | f59c9e5cdefb |
| N-B1 `restartMusicAfterActiveEvent:` | 0xb8b714 | 0xb8b33c | 0xb8b1e4 | 24 | 372de0d975c4 |
| N-C1a `setLoopMP3s:` + 0x58 | 0xb8c940 | 0xb8c568 | 0xb8c410 | 4 | 823f771b48b9 |
| N-C1b `playMP3IfSafe:` (wrapper) | 0xb8b888 | 0xb8b4b0 | 0xb8b358 | 60 | 05fb03696ae3 |
| N-C1c call site `GameView initOpenGL` | 0x9222e8 | 0x921f10 | 0x921db8 | 4 | `e12fff33` |
| N-C1c call site `GameView gameSoundFinshedFadingOut` | 0x93adec | 0x93aa14 | 0x93a8bc | 4 | `e12fff33` |
| N-C1c call site `GameView actuallyDoExitWorldRightNowReallyNow` | 0x932858 | 0x932480 | 0x932328 | 4 | `e12fff33` |
| N-D1 window in `GameView didBecomeActive` (function + 0x324) | 0x9301b8 | 0x92fde0 | 0x92fc88 | 36 | c6dd184095f8 |
| Needed targets: `AVAudioPlayer play` / `pause` IMP | 0x1e1798 / 0x1e19d4 | 0x1e1598 / 0x1e17d4 | 0x1e1518 / 0x1e1754 | | |
| Needed targets: `playMP3IfSafe:withTimeOffset:` / `setLoopMP3s:` IMP | 0xb8b72c / 0xb8c8e8 | 0xb8b354 / 0xb8c510 | 0xb8b1fc / 0xb8c3b8 | | |

New words (little endian ARM; verified by re-disassembling a scratch copy, nothing was run):
* N-A1: `e3a00001 e12fff1e` (`mov r0,#1; bx lr`).
* N-B1 stop (9 words): `e590106c e3a02000 e3510000 15d1202c e5c02072 e3520000 11a00001 <bne pause> e12fff1e`
  (`ldr r1,[r0,#0x6c]; mov r2,#0; cmp r1,#0; ldrbne r2,[r1,#0x2c]; strb r2,[r0,#0x72]; cmp r2,#0; movne r0,r1; bne AVAudioPlayer.pause; bx lr`).
  `<bne pause>`: 1.7.4 `1ad958c6`, 1.7.5 `1ad9593c`, 1.7.6 `1ad95972`.
* N-B1 restart (6 words): `e5d02072 e3520000 1590006c 13500000 012fff1e <b play>`
  (`ldrb r2,[r0,#0x72]; cmp r2,#0; ldrne r0,[r0,#0x6c]; cmpne r0,#0; bxeq lr; b AVAudioPlayer.play`).
  `<b play>`: 1.7.4 `ead9581a`, 1.7.5 `ead95890`, 1.7.6 `ead958c6`.
* N-C1a: `e3e02000` replaces `e30023e7`.
* N-C1b (15 words, identical in all versions because branch distances are identical):
  `e92d4010 e24dd008 e3a03000 e58d3000 e58d3004 ebffffa2 e28dd008 e8bd8010 | e92d4010 e1a04000 ebfffff4 e5d42059 e1a00004 eb000409 e8bd8010`.
  First eight words = entry A (push, make room for the 0.0 double on the stack, `bl playMP3IfSafe:withTimeOffset:`, pop). Next seven = entry B at wrapper+0x20 (`push {r4,lr}; mov r4,r0; bl A; ldrb r2,[r4,#0x59]; mov r0,r4; bl setLoopMP3s:; pop {r4,pc}`). Bytes after the 60th are dead and may stay.
* N-C1c: `eb09a56e` (initOpenGL), `eb0942ad` (gameSoundFinshedFadingOut), `eb096412` (actuallyDoExit...), same in all three versions.
* N-D1 (9 words) replacing `e51b0020 e51b1080 e5912000 e0800002 e5900000 e51b2094 e5921000 e51b307c e12fff33`:
  `e320f000 e51bc020 e59c0014 e5dcc16a e35c0000 e51b2094 e5921000 e51b307c 012fff33`.

Framework requirements (for the hash-pinned native layer): in-place word replacement with a check of the original bytes (hash of the whole replaced range) and the library SHA-256; PC-relative branch word computation per site (done above, but the framework should compute and assert range); no caves, no relocation or data changes. All edited regions are plain ARM code in the R E segment.

## 7. DEX patch list (all in `classes.dex`; identical classes in all three versions)
| Id | Class / method | Edit |
| --- | --- | --- |
| J-A1 | `com.apportable.media.AndroidAudioManager.isMusicActive()Z` | return constant false (replace the `iget-boolean` with `const/4 v0,0`; pad with `nop`) |
| J-A2 | `AndroidAudioManager.waitOnConnection()V` (private, 5 regs) | at entry: `Looper.myLooper() == Looper.getMainLooper()` -> `return-void` |
| J-D1 | `com.apportable.gl.GLSurfaceView.surfaceDestroyed()V` | rewrite as in 3.4 (needs a register-count increase) |
| J-D2 (optional) | `com.apportable.Lifecycle.testInBackground()V` | add null-checked `MainThread.getHandler().sendEmptyMessage(0)` after the native lifecycle calls |
| J-C2 (optional alternative to N-C1a) | `com.apportable.media.AudioPlayer.setNumberOfLoops(II)V` | `if-ne p1, v2(-1)` -> `if-eqz p1, ...` (loop for any non-zero value) |
Manifest: M-1 theme on `com.apportable.ui.TextViewHaxActivity`.

## 8. Device test matrix (minimum)
| Test | Items |
| --- | --- |
| Cold start with and without another app playing; menu music present and looping; no UI stall at start | 2a, 2c, 2d |
| Menu -> home -> return after 5 s and after 5 min; lock/unlock; incoming call | 2b, 4, 16 |
| In-world -> home -> return; share screenshot; photo picker; open a link; welcome message popup | 2b, 4 |
| Enter world from menu (Continue / New / Join), then exit to menu | 2c |
| Select 3rd world, scroll, home, return; cold start; kill from recents then start | 16 |
| Thread dump during any freeze that still occurs | 4 |

## 9. Open questions (cannot be settled statically)
1. Whether the freeze mechanism in 3.2 is exactly the failing path on the user's devices (needs a thread dump).
2. Whether a `Handler` message really wakes `RunLoop.nativeNext` and causes a tick (design of J-D1 step 1 / J-D2).
3. Whether `render:` can run before the first `didBecomeActive` (affects the cold-start behaviour of N-D1).
4. Android-version-dependent behaviour of `MediaPlayer` after long pauses (N-B1).
5. Whether the chat/keyboard hack path (`TextViewHaxActivity`) is reachable on the test device.
