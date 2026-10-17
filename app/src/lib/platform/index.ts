import type { PlatformAdapter } from './types';
import { createWebPlatform } from './web';
import { createTauriDesktopAdapter } from './tauri-desktop';
import { createTauriAndroidAdapter } from './tauri-android';

export * from './types';

export function getPlatform(): PlatformAdapter {
  const w = typeof window !== 'undefined' ? (window as unknown as { __TAURI_INTERNALS__?: unknown }) : undefined;
  if (w?.__TAURI_INTERNALS__) {
    return /android/i.test(navigator.userAgent) ? createTauriAndroidAdapter() : createTauriDesktopAdapter();
  }
  return createWebPlatform();
}
