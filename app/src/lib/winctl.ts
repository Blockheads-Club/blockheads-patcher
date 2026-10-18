// Seam between the custom desktop title bar and the Tauri window (desktop only; mocked in tests).
import { getCurrentWindow } from '@tauri-apps/api/window';

export type Os = 'windows' | 'macos' | 'linux';

/** The OS the bar imitates, from the user agent (the webview has no other signal). */
export function guessOs(ua: string = navigator.userAgent): Os {
  return ua.includes('Windows') ? 'windows' : ua.includes('Mac') ? 'macos' : 'linux';
}

// Async on purpose: outside a Tauri window `getCurrentWindow()` throws, which must surface as a rejection.
export const win = {
  minimize: async () => getCurrentWindow().minimize(),
  toggleMaximize: async () => getCurrentWindow().toggleMaximize(),
  close: async () => getCurrentWindow().close(),
  isMaximized: async () => getCurrentWindow().isMaximized(),
  isFullscreen: async () => getCurrentWindow().isFullscreen(),
  onResized: async (cb: () => void) => getCurrentWindow().onResized(cb),
  onFocus: async (cb: (focused: boolean) => void) => getCurrentWindow().onFocusChanged((e) => cb(e.payload))
};
