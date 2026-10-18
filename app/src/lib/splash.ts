// Seam between the splash UI and the Tauri host (desktop only): the hidden main window runs the boot work and
// pushes its state, the separate splash window renders it. See src-tauri/src/splash.rs.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type BootPhase = 'loading' | 'slow' | 'error';

/** What the splash window shows (matches `SplashState` in Rust). */
export interface SplashState { boot: BootPhase; error: string; version: string; lang: string; }

export const splashIpc = {
  /** Main window -> host: the current boot state for the splash window. */
  set: (state: SplashState) => invoke<void>('splash_set', { state }),
  get: () => invoke<SplashState>('splash_get'),
  /** Splash window -> main window: run the boot work again. */
  retry: () => invoke<void>('splash_retry'),
  quit: () => invoke<void>('app_quit'),
  /** Writes the boot error to the log folder and shows it. */
  openLog: () => invoke<void>('open_log'),
  /** The boot work is done: show the main window, close the splash. */
  mainReady: () => invoke<void>('main_ready'),
  onState: (cb: (s: SplashState) => void) => listen<SplashState>('splash-state', (e) => cb(e.payload)),
  onRetry: (cb: () => void) => listen('splash-retry', () => cb())
};
